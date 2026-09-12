import ssl
from urllib.parse import urlsplit

from websockets.sync.client import connect


def local_context():
    context = ssl.create_default_context()
    context.load_verify_locations('/session/cert.pem')
    return context


def connect_local(url, **options):
    address = urlsplit(url)
    if address.scheme != 'wss' or address.hostname != 'host.docker.internal':
        raise ValueError('Only the local meeting bridge is permitted')
    return connect(url, ssl=local_context(), open_timeout=15, **options)
