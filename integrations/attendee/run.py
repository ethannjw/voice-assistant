import base64
import json
import os
import pathlib
import secrets
import signal
import subprocess
import sys
import time

root = pathlib.Path(__file__).parent
state = pathlib.Path(os.environ['ELVA_MEETING_STATE'])
project = os.environ['ELVA_MEETING_PROJECT']
compose = ['docker', 'compose', '--project-name', project, '--file', str(root / 'compose.yaml')]
configuration = json.loads(sys.stdin.readline())
bot = None
stopping = False
result = 1


def emit(**fields):
    print(json.dumps(fields), flush=True)


def stop(signum, frame):
    global stopping
    stopping = True
    (state / 'public' / 'stop').touch()


def execute(arguments, timeout=180):
    completed = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if completed.returncode:
        raise RuntimeError('Container operation failed; check Docker and the configured Attendee image.')


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    descriptor = os.open(state / 'runtime.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as config:
        config.write('DJANGO_SECRET_KEY=' + secrets.token_hex(32) + '\n')
        config.write('CREDENTIALS_ENCRYPTION_KEY=' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode() + '\n')
    execute(compose + ['config', '--quiet'])
    execute(compose + ['run', '--rm', '--no-deps', 'app', 'python', '/elva/check_guards.py'])
    if configuration.get('check_only'):
        emit(state='Runtime safety checks passed')
        result = 0
    elif not stopping and not (state / 'public' / 'stop').exists():
        emit(state='Starting meeting runtime')
        execute(compose + ['up', '--detach', '--wait', '--wait-timeout', '60', 'postgres', 'redis'])
        execute(compose + ['run', '--rm', '--no-deps', 'app', 'python', 'manage.py', 'migrate', '--noinput'])
        if not stopping and not (state / 'public' / 'stop').exists():
            bot = subprocess.Popen(compose + ['run', '--rm', '--no-deps', '--name', project + '-bot', '--no-TTY', 'bot'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            bot.stdin.write(json.dumps(configuration) + '\n')
            bot.stdin.close()
            started = time.monotonic()
            import selectors
            selector = selectors.DefaultSelector()
            selector.register(bot.stdout, selectors.EVENT_READ)
            while bot.poll() is None:
                for key, mask in selector.select(timeout=1):
                    line = key.fileobj.readline()
                    if line.startswith('{'):
                        try:
                            event = json.loads(line)
                            emit(**{name: value for name, value in event.items() if name in ('state', 'result', 'action', 'joined', 'final_state', 'audio_chunks', 'utterances', 'recording_files', 'media_files', 'blocked_aws_attempts', 'audio_error')})
                        except ValueError:
                            pass
                if time.monotonic() - started > configuration['duration_seconds'] + 360:
                    stopping = True
                if stopping:
                    execute(['docker', 'stop', '--time', '10', project + '-bot'], timeout=30)
                    break
            for line in bot.stdout:
                if line.startswith('{'):
                    try:
                        event = json.loads(line)
                        emit(**{name: value for name, value in event.items() if name in ('joined', 'final_state', 'audio_chunks', 'utterances', 'recording_files', 'media_files', 'blocked_aws_attempts', 'audio_error')})
                    except ValueError:
                        pass
            result = bot.wait(timeout=30)
            selector.close()
except Exception as error:
    emit(error=type(error).__name__, state='Meeting runtime failed; check Docker and ATTENDEE_IMAGE')
finally:
    try:
        cleanup = subprocess.run(compose + ['down', '--timeout', '10'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        emit(state='Meeting runtime stopped', cleanup_exit_code=cleanup.returncode)
        if cleanup.returncode:
            result = 1
    except Exception:
        emit(error='CleanupFailed', state='Meeting container cleanup needs retry')
        result = 1
sys.exit(result)
