import pathlib
import tempfile
import unittest

from build import INDEX, prepare


class BuildTests(unittest.TestCase):
    def test_artifactory_covers_base_and_dependencies_with_verified_tls(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory)
            (source / 'requirements.txt').write_text('boto3==1.35.64\nbotocore==1.35.64\nother==2\n')
            (source / 'Dockerfile').write_text('FROM ubuntu:22.04 AS base\nARG DEBIAN_FRONTEND=noninteractive\n'
                                             '# Install a specific version of Chrome.\nRUN pip install av\n'
                                             'FROM base AS deps\nRUN pip install -r requirements.txt\n')
            certificate = source / 'corporate.pem'
            certificate.write_text('test certificate')
            prepare(source, certificate)
            dockerfile = (source / 'Dockerfile').read_text()
            self.assertIn('ARG PIP_INDEX_URL=' + INDEX, dockerfile)
            self.assertLess(dockerfile.index('ARG PIP_INDEX_URL='), dockerfile.index('RUN pip install'))
            self.assertIn('PIP_EXTRA_INDEX_URL="" PIP_CONFIG_FILE=/dev/null', dockerfile)
            self.assertIn('RUN update-ca-certificates', dockerfile)
            self.assertNotIn('trusted-host', dockerfile)
            self.assertEqual((source / 'requirements.txt').read_text(), 'boto3==1.35.99\nbotocore==1.35.99\nother==2\n')
            self.assertEqual((source / 'elva-corporate-ca.crt').read_text(), 'test certificate')


if __name__ == '__main__':
    unittest.main()
