---
allowedTools: ["readFile", "glob", "grep", "listDirectory", "bash"]
description: "Perform a code review on the specified files or changes"
---

Perform a code review on: $ARGUMENTS

Review criteria:
1. Code correctness and logic
2. Code style and consistency
3. Error handling
4. Performance considerations
5. Security issues
6. Test coverage

If no specific files are mentioned, review recent changes (git diff).
Provide a summary with any issues found and suggestions for improvement.