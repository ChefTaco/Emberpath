# Security Policy

## Supported versions

Security fixes are released for the latest `1.x` version.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/hive/security/advisories/new).
Please include:

- the affected component (Router, IAM, HiveMem, Skills, or an SDK) and version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Run every service over TLS in production, and keep admin listeners on a private network.
- Keep `.env` files, IAM signing keys, and TLS keys readable only by root or the service user.
- Rotate secrets with `npm run rotate:secrets` (see [docs/SECRET_ROTATION.md](docs/SECRET_ROTATION.md)).
