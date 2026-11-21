# Guard branch fixture

A clean git baseline on a protected branch. Nothing here should be modified.

The runtime harness guard must reject git writes that target `main` or
`master`, including when the command is wrapped in a shell interpreter.
