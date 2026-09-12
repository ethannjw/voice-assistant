import json
import logging
import pathlib
import sys
import time

import django
import sitecustomize

django.setup()
logging.disable(logging.CRITICAL)

from bots.bots_api_utils import BotCreationSource, create_bot
from bots.models import AudioChunk, BotEventManager, BotEventTypes, BotStates, Organization, Participant, Project, Recording, TranscriptionTypes, Utterance
from gi.repository import GLib
from privacy import DISPLAY_NAME
from policy import MeetingController
from tls import connect_local
import bots.bot_controller.bot_websocket_client as websocket_client

websocket_client.connect = connect_local


def emit(**result):
    print(json.dumps(result), flush=True)


assert sitecustomize.GUARD_ACTIVE
configuration = json.loads(sys.stdin.readline())
assert configuration['meeting_url'].startswith(('https://teams.microsoft.com/', 'https://teams.live.com/'))
assert configuration['url'].startswith('wss://host.docker.internal:')
organization = Organization.objects.create(name='Elva Teams meeting')
project = Project.objects.create(name='Elva Teams meeting', organization=organization)
bot, errors = create_bot({
    'meeting_url': configuration['meeting_url'],
    'bot_name': configuration.get('name', DISPLAY_NAME),
    'recording_settings': {'format': 'none'},
    'websocket_settings': {'audio': {'url': configuration['url'], 'sample_rate': 24000}},
    'debug_settings': {'create_debug_recording': False},
    'automatic_leave_settings': {'waiting_room_timeout_seconds': 300, 'only_participant_in_meeting_timeout_seconds': 45, 'max_uptime_seconds': configuration['duration_seconds'] + 300},
}, BotCreationSource.API, project)
if errors:
    emit(result='BOT_CREATION_FAILED', error_fields=list(errors))
    sys.exit(1)
Recording.objects.filter(bot=bot).update(transcription_type=TranscriptionTypes.NO_TRANSCRIPTION)
controller = MeetingController(bot.id)
started = time.monotonic()
joined_at = None
leaving = False
previous_state = None


def observe():
    global joined_at, leaving, previous_state
    bot.refresh_from_db()
    if bot.state != previous_state:
        emit(state=BotStates(bot.state).label, elapsed_seconds=round(time.monotonic() - started))
        previous_state = bot.state
    if bot.state == BotStates.JOINED_NOT_RECORDING and joined_at is None:
        joined_at = time.monotonic()
        emit(result='JOINED', participant_records=Participant.objects.filter(bot=bot).count())
    if (controller.meeting_stop or pathlib.Path('/session/stop').exists() or (joined_at and time.monotonic() - joined_at > configuration['duration_seconds'])) and not leaving:
        leaving = True
        BotEventManager.create_event(bot=bot, event_type=BotEventTypes.LEAVE_REQUESTED)
        BotEventManager.set_requested_bot_action_taken_at(bot)
        controller.bot_in_db.refresh_from_db()
        controller.adapter.leave()
        emit(action='LEAVE_REQUESTED', audio_error=controller.meeting_error)
    return not controller.cleanup_called


GLib.timeout_add_seconds(1, observe)
GLib.timeout_add(100, controller.poll_audio)
emit(action='JOIN_START', participant_name=DISPLAY_NAME, recording=False, persisted_transcription=False, aws_sdk_access=False)
try:
    controller.run()
except Exception as error:
    emit(result='CONTROLLER_EXCEPTION', exception_type=type(error).__name__)
    raise SystemExit(1)
finally:
    bot.refresh_from_db()
    audio_chunks = AudioChunk.objects.filter(recording__bot=bot).count()
    utterances = Utterance.objects.filter(recording__bot=bot).count()
    files = sum(bool(recording.file) for recording in Recording.objects.filter(bot=bot))
    media_files = sum(path.is_file() for path in pathlib.Path('/tmp/elva-media').rglob('*'))
    events = [{'type': event.get_event_type_display(), 'subtype': event.get_event_sub_type_display()} for event in bot.bot_events.all()]
    emit(joined=joined_at is not None, final_state=BotStates(bot.state).label, audio_chunks=audio_chunks, utterances=utterances, recording_files=files, media_files=media_files, blocked_aws_attempts=sitecustomize.BLOCKED_AWS_CALLS, audio_error=controller.meeting_error, events=events)
    if audio_chunks or utterances or files or media_files or sitecustomize.BLOCKED_AWS_CALLS:
        raise SystemExit(2)
sys.exit(0 if joined_at is not None and not controller.meeting_error else 1)
