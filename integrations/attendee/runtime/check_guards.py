import json
import os
import unittest

import boto3
import django
import sitecustomize
from botocore.client import BaseClient

django.setup()

from django.core.files.storage import FileSystemStorage, storages
from privacy import PrivateController, PrivateTeamsAdapter
from policy import MeetingController, MeetingTeamsAdapter
from tls import local_context


class NoCloudTests(unittest.TestCase):
    def test_meeting_bridge_certificate_is_readable_with_verification(self):
        import ssl
        context = local_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_meeting_pipeline_only_streams_audio(self):
        controller = object.__new__(MeetingController)
        settings = vars(controller.get_pipeline_configuration())
        self.assertEqual([name for name, enabled in settings.items() if enabled], ['websocket_stream_audio'])
        self.assertFalse(controller.should_capture_audio_chunks())
        self.assertFalse(controller.save_utterances_for_closed_captions())
        adapter = object.__new__(MeetingTeamsAdapter)
        self.assertEqual(adapter.capture_screenshot_and_mhtml_file(), (None, None, None))

    def test_guard_loaded(self):
        self.assertTrue(sitecustomize.GUARD_ACTIVE)
        self.assertEqual(os.environ["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertEqual(os.environ["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")

    def test_client_creation_stops_before_network(self):
        with self.assertRaises(sitecustomize.CloudAccessDisabled):
            boto3.client("s3", region_name="us-east-1")

    def test_existing_client_api_calls_stop_before_network(self):
        with self.assertRaises(sitecustomize.CloudAccessDisabled):
            BaseClient._make_api_call(None, "ListBuckets", {})

    def test_all_media_storage_is_local(self):
        for alias in ("default", "recordings", "audio_chunks", "bot_debug_screenshots"):
            self.assertIsInstance(storages[alias], FileSystemStorage)
            self.assertTrue(storages[alias].location.startswith("/tmp/elva-media/"))

    def test_capture_configuration_is_disabled(self):
        controller = object.__new__(PrivateController)
        self.assertFalse(any(vars(controller.get_pipeline_configuration()).values()))
        self.assertFalse(controller.should_capture_audio_chunks())
        self.assertFalse(controller.save_utterances_for_closed_captions())
        self.assertFalse(controller.save_utterances_for_individual_audio_chunks())
        with self.assertRaises(RuntimeError):
            controller.process_individual_audio_chunk()
        with self.assertRaises(RuntimeError):
            controller.save_closed_caption_utterance()

    def test_caption_and_name_bypass_ui_is_not_invoked(self):
        adapter = object.__new__(PrivateTeamsAdapter)
        self.assertIsNone(adapter.after_bot_can_record_meeting())
        self.assertEqual(adapter.capture_screenshot_and_mhtml_file(), (None, None, None))
        self.assertIsNone(adapter.click_captions_button())
        self.assertIsNone(adapter.update_closed_captions_language("en-US"))
        self.assertIsNone(adapter.set_display_name_to_allow("Elva (AI assistant)"))


if __name__ == "__main__":
    unittest.main()
