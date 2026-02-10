# Security Policy

## Reporting Security Issues

We take the security of Agentboard seriously. If you believe you have found a security vulnerability, please report it to us privately. **Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them via:
- [GitHub Security Advisory](https://github.com/gbasin/agentboard/security/advisories/new)

### Reporting Process
1. **Submit Report**: Use the above channel to submit your report
2. **Response Time**: We will acknowledge receipt of your report within 14 business days
3. **Collaboration**: We will collaborate with you to understand and validate the issue
4. **Resolution**: We will work on a fix and coordinate the release process

### Disclosure Policy
- Please provide detailed reports with reproducible steps
- Include the version/commit hash where you discovered the vulnerability
- Allow us a 90-day security fix window before any public disclosure
- After a patch is released, allow 30 days for users to update before public disclosure (for a total of 120 days max)
- Share any potential mitigations or workarounds if known

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest commit on the default branch | Yes |
| Latest published npm package (`@gbasin/agentboard`) | Yes |
| All other versions | No |


## Security Considerations

Agentboard provides a web-based interface to tmux terminal sessions. By design, it grants terminal access to connected clients.

---
Last updated: February 2026
