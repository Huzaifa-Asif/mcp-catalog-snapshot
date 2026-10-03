# Security policy

## Supported versions

Security fixes are provided for the latest major version.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting feature for this repository. If that feature is unavailable, contact the maintainer through the address on the GitHub profile and include the affected version, reproduction, impact, and suggested mitigation.

Expect an acknowledgement within seven days. Publication timelines will be coordinated after impact and remediation are understood.

## Scope notes

This package does not open network connections, authenticate to MCP servers, parse transports, or establish a security boundary around untrusted item objects. It bounds catalog collection and reports incomplete results; callers remain responsible for transport security, authorization, schema validation, and choosing appropriate limits.
