from attendee.settings.development import *

DEBUG = False
USE_REMOTE_STORAGE_FOR_AUDIO_CHUNKS = False
MEDIA_ROOT = "/tmp/elva-media"
STORAGES = {
    alias: {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {"location": f"{MEDIA_ROOT}/{alias}"},
    }
    for alias in ("default", "recordings", "audio_chunks", "bot_debug_screenshots")
}
STORAGES["staticfiles"] = {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}
