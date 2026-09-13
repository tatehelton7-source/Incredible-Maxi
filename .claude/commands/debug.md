---
allowedTools: ["readFile", "writeFile", "editFile", "bash", "listDirectory", "glob", "grep"]
description: "Debug a failing test or issue using systematic debugging workflow"
---

Debug the issue: $ARGUMENTS

Follow the systematic debugging workflow:
1. **Reproduce** - Run the failing test/command to confirm the issue
2. **Isolate** - Narrow down the root cause by examining relevant code
3. **Hypothesize** - Form theories about the root cause
4. **Test** - Verify each hypothesis with targeted experiments
5. **Fix** - Implement the minimal fix
6. **Verify** - Run tests to confirm the fix works
7. **Prevent** - Add tests or safeguards to prevent regression

If it's a failing test, run it first to see the error output.
Then systematically work through the code to find the root cause.