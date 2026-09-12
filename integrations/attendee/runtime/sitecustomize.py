import os

GUARD_ACTIVE = False
BLOCKED_AWS_CALLS = 0


class CloudAccessDisabled(RuntimeError):
    pass


def deny_aws(*arguments, **keywords):
    global BLOCKED_AWS_CALLS
    BLOCKED_AWS_CALLS += 1
    raise CloudAccessDisabled("AWS SDK access is disabled for the local meeting runtime")


if os.environ.get("ELVA_NO_CLOUD") == "1":
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
    os.environ["AWS_CONFIG_FILE"] = "/dev/null"
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = "/dev/null"
    for variable in (
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
        "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_ROLE_ARN", "SENTRY_DSN",
    ):
        os.environ.pop(variable, None)
    import botocore.client
    import botocore.session

    botocore.session.Session.create_client = deny_aws
    botocore.client.BaseClient._make_api_call = deny_aws
    GUARD_ACTIVE = True
