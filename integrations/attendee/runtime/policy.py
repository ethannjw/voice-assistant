import collections
import json
import pathlib
import threading
import time
from unittest.mock import patch

from bots.bot_controller.bot_controller import BotController
from privacy import PrivateController, PrivateTeamsAdapter


class MeetingTeamsAdapter(PrivateTeamsAdapter):
    def after_bot_can_record_meeting(self):
        if self.recording_permission_granted_at is not None:
            return
        self.recording_permission_granted_at = time.time()
        self.driver.execute_script(pathlib.Path('/elva/playback.js').read_text())
        self.send_frames = True
        self.driver.execute_script('window.ws?.enableMediaSending();')
        self.first_buffer_timestamp_ms_offset = self.driver.execute_script('return performance.timeOrigin;')
        self.media_sending_enable_timestamp_ms = time.time() * 1000


class MeetingController(PrivateController):
    def __init__(self, bot_id):
        self.output_commands = collections.deque()
        self.output_lock = threading.Lock()
        self.bridge_heartbeat = time.monotonic()
        self.meeting_stop = False
        self.meeting_error = False
        self.meeting_initialized = False
        super().__init__(bot_id)

    def get_pipeline_configuration(self):
        configuration = super().get_pipeline_configuration()
        configuration.websocket_stream_audio = True
        return configuration

    def get_teams_bot_adapter(self):
        with patch('bots.teams_bot_adapter.TeamsBotAdapter', MeetingTeamsAdapter):
            adapter = BotController.get_teams_bot_adapter(self)
        assert adapter.add_mixed_audio_chunk_callback is not None
        for callback in ('upsert_caption_callback', 'add_audio_chunk_callback', 'add_per_participant_video_frame_callback', 'add_encoded_mp4_chunk_callback', 'start_recording_screen_callback', 'stop_recording_screen_callback'):
            assert getattr(adapter, callback) is None, callback
        assert not adapter.should_create_debug_recording
        return adapter

    def on_message_from_websocket_audio(self, message_json):
        try:
            message = json.loads(message_json) if isinstance(message_json, str) else message_json
            trigger = message.get('trigger')
            if trigger == 'elva.heartbeat':
                self.bridge_heartbeat = time.monotonic()
                return
            if trigger == 'elva.stop':
                self.meeting_stop = True
                return
            if trigger not in ('realtime_audio.bot_output', 'elva.done', 'elva.clear'):
                raise ValueError('Unknown command')
            if len(json.dumps(message)) > 128500:
                raise ValueError('Oversized command')
            with self.output_lock:
                if len(self.output_commands) >= 50:
                    raise ValueError('Output queue full')
                self.output_commands.append(message)
        except Exception:
            self.meeting_error = True
            self.meeting_stop = True

    def poll_audio(self):
        if self.cleanup_called:
            return False
        try:
            if not self.meeting_initialized:
                if not self.adapter.recording_permission_granted_at:
                    return True
                self.meeting_initialized = True
                self.bridge_heartbeat = time.monotonic()
                self.websocket_client_manager.send_mixed_audio({'trigger': 'elva.ready'})
            if time.monotonic() - self.bridge_heartbeat > 20:
                self.meeting_stop = True
                self.meeting_error = True
            with self.output_lock:
                commands = list(self.output_commands)
                self.output_commands.clear()
            if self.meeting_stop:
                self.adapter.driver.execute_script('window.elvaMeeting?.clear();')
                return False
            events = self.adapter.driver.execute_script('for (const command of arguments[0]) window.elvaMeeting.command(command); return window.elvaMeeting.poll();', commands)
            for event in events:
                self.websocket_client_manager.send_mixed_audio({'trigger': 'elva.playback', 'data': event})
            self.websocket_client_manager.send_mixed_audio({'trigger': 'elva.heartbeat'})
        except Exception:
            self.meeting_error = True
            self.meeting_stop = True
            return False
        return True
