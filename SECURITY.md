# Security policy

Flowcraft is beta software and has not had a formal audit.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact. I'll respond as soon as I can.

## Scope notes

- Credentials are not stored unless the user enables "Store usernames/passwords"; if enabled they are plaintext in `chrome.storage.local` and in exports (see [docs/security.md](docs/security.md)).
- The extension makes no network requests and ships no third-party code.
