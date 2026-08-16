# Writing guideline

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward correctness, simplicity, and controlled changes over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- Inspect the relevant code, tests, types, and existing patterns first.
- Do not invent requirements, constraints, APIs, or failure modes that are not supported by evidence.
- State assumptions explicitly when they materially affect the implementation.
- If multiple interpretations exist, surface them instead of silently choosing one.
- If a simpler approach exists, prefer it and say so when the tradeoff matters.
- Ask for clarification only when the ambiguity cannot be resolved from the codebase and would materially change the implementation.
- If something is unclear, do not hide the uncertainty behind defensive code.

## 2. Simplicity First

**Write the minimum code that solves the actual problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for hypothetical future needs.
- No "flexibility" or "configurability" that was not requested.
- No over engineering.
- Prefer deletion over addition when both solve the problem.
- If two approaches are equivalent, use the simpler one.
- Reuse existing code, standard library features, platform features, and established project patterns before introducing new machinery.
- Do not create helpers, wrappers, classes, utilities, or abstractions for a one-off operation unless they materially improve clarity.
- Avoid indirection that only moves a few obvious lines somewhere else.
- If you write 200 lines and it could reasonably be 50, rewrite it.

Ask yourself:

> Would a senior engineer looking at this diff ask why this is so complicated?

If yes, simplify it.

## 3. Avoid Defensive Overengineering

**Validate boundaries. Trust internal contracts. Don't hide failures.**

- Validate untrusted inputs and system boundaries, not every internal call.
- Don't add checks or fallbacks for states that established contracts say cannot happen.
- Don't add speculative retries, defaults, or error handling "just in case."
- Never swallow errors or turn failures into apparently valid results.
- If an impossible state can actually happen, fix the contract or root cause instead of scattering defensive checks.

If an "impossible" state is actually reachable, fix the violated contract or validate it at the correct boundary rather than scattering guards throughout the codebase.

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, formatting, or naming unless required for the requested change.
- Don't refactor unrelated code.
- Match the existing style and architecture unless changing them is part of the task.
- If you notice unrelated dead code or problems, mention them instead of silently fixing them.

When your changes create orphans:
- Remove imports, variables, functions, files, or dependencies made unused by YOUR changes.
- Don't remove pre-existing dead code unless asked.

Every changed line should trace directly to:
1. The user's request.
2. A necessary consequence of implementing that request.
3. Cleanup caused by your own changes.

If it does not, it probably should not be in the diff.

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into concrete, verifiable goals.

Examples:
- "Add validation" → "Define the invalid inputs, add tests for them, then make those tests pass."
- "Fix the bug" → "Reproduce the bug, fix it, then verify the reproduction no longer fails."
- "Refactor X" → "Verify behavior before and after the refactor remains equivalent."
- "Improve performance" → "Establish a baseline, change one relevant thing, then compare measurements."

For multi-step tasks, use a brief plan when useful:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Verification should match the scope of the change:
- Start with the smallest relevant test, check, build, or reproduction.
- Expand verification only when needed.
- Do not fix unrelated failures encountered during verification.
- Do not declare success without performing the relevant verification when it is available.

Strong success criteria allow independent iteration. Weak criteria such as "make it work" encourage unnecessary changes and hidden assumptions.

## 6. Resource-Aware Execution

**Do not overload the local machine while building, testing, or running development tasks.**

- Do not run multiple resource-intensive commands in parallel by default.
- Prefer sequential execution for builds, tests, benchmarks, dependency installation, and other potentially expensive jobs.
- Before starting concurrent jobs, consider their combined CPU, memory, disk I/O, GPU, and process usage.
- Only run expensive jobs concurrently when you are confident they will not cause OOM, severe swapping, system freezes, excessive thermal load, or otherwise make the machine unusable.
- Prefer the smallest relevant command first: run targeted tests, builds, benchmarks, or checks before expanding to the entire project.
- Do not repeatedly run expensive full-project commands when a narrower verification is sufficient.
- Avoid leaving unnecessary background processes running after they are no longer needed.
- Stop or clean up processes started during the task when they are no longer required.

When uncertain, choose the safer and less resource-intensive execution strategy over faster parallel execution.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.