# Security

Credentials never leave your machine: they are read from the environment, `~/.config/social/.env` (mode 0600) or the OS keyring, and sent only to the platform they belong to. Nothing is logged; `ApiError` messages carry the URL and response body but never the `Authorization` header.

If you find a way this tool can leak a credential or act on an account without the user asking, email the address on the GitHub profile of the maintainer rather than opening a public issue. Expect a reply within a week.
