import argparse
import pathlib
import shutil
import subprocess
import tempfile

REVISION = '31ebd91f3a318ac4bc266240b8fef3f26bec333a'
INDEX = 'https://art-toucan.autodesk.com/artifactory/api/pypi/autodesk-pypi-virtual/simple'


def prepare(source, certificate=None):
    requirements = source / 'requirements.txt'
    text = requirements.read_text()
    for package in ('boto3', 'botocore'):
        text = text.replace(package + '==1.35.64', package + '==1.35.99')
    requirements.write_text(text)
    dockerfile = source / 'Dockerfile'
    text = dockerfile.read_text()
    settings = ('ARG PIP_INDEX_URL=' + INDEX + '\n'
                'ENV PIP_EXTRA_INDEX_URL="" PIP_CONFIG_FILE=/dev/null\n'
                'ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt\n')
    text = text.replace('ARG DEBIAN_FRONTEND=noninteractive', 'ARG DEBIAN_FRONTEND=noninteractive\n' + settings, 1)
    if certificate:
        shutil.copyfile(certificate, source / 'elva-corporate-ca.crt')
        text = text.replace('# Install a specific version of Chrome.',
                            'COPY elva-corporate-ca.crt /usr/local/share/ca-certificates/elva-corporate-ca.crt\n'
                            'RUN update-ca-certificates\n\n# Install a specific version of Chrome.', 1)
    dockerfile.write_text(text)


def main():
    parser = argparse.ArgumentParser(description='Build the pinned local Attendee runtime using Autodesk Artifactory for all Python packages.')
    parser.add_argument('--ca-cert', type=pathlib.Path, help='Optional corporate PEM CA certificate; TLS verification remains enabled.')
    parser.add_argument('--image', default='elva-attendee:31ebd91')
    options = parser.parse_args()
    if options.ca_cert and not options.ca_cert.is_file():
        parser.error('CA certificate must be an existing PEM file.')
    with tempfile.TemporaryDirectory(prefix='elva-attendee-build-') as directory:
        source = pathlib.Path(directory) / 'attendee'
        subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/attendee-labs/attendee.git', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', '--detach', REVISION], check=True)
        prepare(source, options.ca_cert)
        subprocess.run(['docker', 'build', '--platform', 'linux/amd64', '--tag', options.image,
                        '--build-arg', 'PIP_INDEX_URL=' + INDEX, str(source)], check=True)


if __name__ == '__main__':
    main()
