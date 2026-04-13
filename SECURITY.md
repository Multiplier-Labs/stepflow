# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | Yes                |
| < 0.2   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in Stepflow, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@multiplier-labs.com** with:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested remediation (optional)

We will acknowledge receipt within **48 hours** and aim to provide an initial assessment within **5 business days**.

## Disclosure Policy

- We follow coordinated disclosure. Please allow us reasonable time to address the issue before public disclosure.
- Once a fix is released, we will publish a security advisory via GitHub Security Advisories.
- Contributors who report valid vulnerabilities will be credited in the advisory (unless they prefer anonymity).

## Security Practices

This project follows these security practices:

- **Signed commits** are encouraged for all contributors
- **Branch protection** is enforced on `main` with required reviews and status checks
- **Dependency scanning** via Dependabot with automated PRs for security updates
- **npm audit** runs in CI on every pull request
- **Secret scanning** and **push protection** are enabled on the repository
- **CODEOWNERS** requires review from designated maintainers for security-sensitive code paths
