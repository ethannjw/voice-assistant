from dataclasses import fields
from types import SimpleNamespace
from unittest.mock import patch

from bots.bot_adapter import BotAdapter
from bots.bot_controller.bot_controller import BotController
from bots.bot_controller.pipeline_configuration import PipelineConfiguration
from bots.teams_bot_adapter import TeamsBotAdapter

DISPLAY_NAME = "Elva AI assistant"


class PrivateTeamsAdapter(TeamsBotAdapter):
    def after_bot_can_record_meeting(self):
        return None

    def capture_screenshot_and_mhtml_file(self):
        return None, None, None

    def click_captions_button(self):
        return None

    def update_closed_captions_language(self, language):
        return None

    def set_display_name_to_allow(self, display_name):
        return None


class PrivateController(BotController):
    def get_pipeline_configuration(self):
        return SimpleNamespace(**{field.name: False for field in fields(PipelineConfiguration)})

    def save_utterances_for_individual_audio_chunks(self):
        return False

    def save_utterances_for_closed_captions(self):
        return False

    def should_capture_audio_chunks(self):
        return False

    def process_individual_audio_chunk(self, *arguments, **keywords):
        raise RuntimeError("Audio capture is prohibited in the local meeting runtime")

    def save_closed_caption_utterance(self, *arguments, **keywords):
        raise RuntimeError("Transcription is prohibited in the local meeting runtime")

    def on_new_chat_message(self, *arguments, **keywords):
        return None

    def get_teams_bot_adapter(self):
        with patch("bots.teams_bot_adapter.TeamsBotAdapter", PrivateTeamsAdapter):
            adapter = super().get_teams_bot_adapter()
        for callback in (
            "upsert_caption_callback", "add_audio_chunk_callback", "add_mixed_audio_chunk_callback",
            "add_per_participant_video_frame_callback", "add_encoded_mp4_chunk_callback",
            "start_recording_screen_callback", "stop_recording_screen_callback",
        ):
            assert getattr(adapter, callback) is None, callback
        assert not adapter.should_create_debug_recording
        assert not adapter.modify_dom_for_video_recording
        return adapter

    def take_action_based_on_message_from_adapter(self, message):
        if message.get("message") == BotAdapter.Messages.BOT_RECORDING_PERMISSION_GRANTED:
            return None
        if message.get("message") == BotAdapter.Messages.BLOCKED_BY_PLATFORM_REPEATEDLY:
            from bots.models import BotEventManager, BotEventTypes

            BotEventManager.create_event(bot=self.bot_in_db, event_type=BotEventTypes.COULD_NOT_JOIN, event_metadata={"reason": "platform_blocked"})
            self.cleanup()
            return None
        return super().take_action_based_on_message_from_adapter(message)
