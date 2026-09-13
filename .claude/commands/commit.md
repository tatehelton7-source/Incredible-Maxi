---
allowedTools: ["bash", "readFile", "writeFile", "editFile", "listDirectory", "glob", "grep"]
description: "Create a git commit with a message and optionally push"
---

Create a git commit with the message: $ARGUMENTS

Steps:
1. Check git status to see what files have changed
2. Stage all changes with `git add -A`
3. Create a commit with the provided message
4. Optionally push to remote if requested

If the user wants to push, they can say "and push" in the arguments.