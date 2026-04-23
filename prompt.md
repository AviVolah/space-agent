# SpaceAgent ChatGPT Subscription Auth

## Summary

This project is about modifying SpaceAgent so it can use a user's ChatGPT subscription through a locally installed Codex app, while keeping SpaceAgent's own harness, prompt assembly, execution flow, and UI behavior.

The intent is explicitly **not** to make SpaceAgent use the Codex harness. Codex should only be used as the local machine integration point for authentication and subscription-backed access.

The new functionality should be added to **both SpaceAgent chat surfaces**:

1. the admin chat
2. the onscreen agent overlay

The current API-based configuration should remain available, but SpaceAgent should gain a new native subscription-oriented provider path in the UI.

## What Needs To Be Achieved

Add a new provider mode to SpaceAgent that allows a user to sign in with their local Codex installation and then use ChatGPT subscription-backed inference from inside SpaceAgent.

The result should be:

- SpaceAgent keeps its own harness
- SpaceAgent keeps its own prompt-building and execution system
- SpaceAgent gains a new `Subscription` provider in the UI
- users can authenticate through Codex installed on their machine
- if Codex is already logged in, SpaceAgent should reuse that existing state
- if Codex is installed but not logged in, SpaceAgent should initiate a Codex-backed sign-in flow
- Codex installation is required
- no direct browser OAuth fallback should be added when Codex is missing

## Product Requirements

### UI

Both SpaceAgent chat settings surfaces should gain a third provider option:

- `API`
- `Local`
- `Subscription`

The `Subscription` section should present machine/auth status clearly, for example:

- Codex not installed
- Codex installed but not authenticated
- Codex authenticated and ready

The user should be able to:

- refresh Codex/auth status
- start a Codex-backed sign-in flow
- select a model supported by the subscription-backed transport

This must exist in both:

- the admin chat settings
- the onscreen agent settings

### Behavior

SpaceAgent must continue to own:

- prompt assembly
- tool use
- execution handling
- transport orchestration from its own runtime
- chat UX

Codex must **not** become the agent runtime or message harness.

Codex should only be used for:

- detecting whether it is installed
- checking login status
- initiating or reusing local authentication
- enabling SpaceAgent to access the user's ChatGPT subscription-backed inference path

## Technical Direction

### Recommended Architecture

Implement a **native subscription provider inside SpaceAgent**, not a separate standalone bridge process as the primary UX.

This likely means:

1. frontend changes in SpaceAgent for the new provider mode in both chat surfaces
2. a narrow server-side/local-machine integration layer in SpaceAgent to safely interact with the locally installed Codex environment
3. a subscription-backed transport adapter that SpaceAgent calls instead of its normal API-key OpenAI-compatible path when `Subscription` is selected

### Why This Architecture

This matches the intended product shape:

- native SpaceAgent UI
- native SpaceAgent provider selection
- SpaceAgent's own harness remains authoritative
- Codex is used for auth/session/subscription access only

### What Not To Do

Do **not**:

- make SpaceAgent call Codex as the actual agent harness
- replace SpaceAgent's execution flow with Codex execution flow
- depend on Codex `exec` or Codex review flows for normal chat behavior
- implement direct browser OAuth fallback when Codex is not installed
- reduce the feature to "just point SpaceAgent at an OpenAI-compatible local bridge and treat it as API-only"

## Known Integration Facts

During exploration, the local Codex CLI showed:

- `codex login status`
- `codex login`
- `codex logout`

Observed behavior:

- `codex login status` can return `Logged in using ChatGPT`

That means Codex exposes a real local login surface that can be used as the machine integration point.

However, login status alone is probably not enough to actually perform subscription-backed inference from SpaceAgent. The implementation will likely also need to safely reuse Codex-managed local auth state or a Codex-owned authenticated path on the machine.

## Expected Implementation Areas In SpaceAgent

The likely SpaceAgent areas to modify are:

- the admin chat provider settings/config/runtime
- the onscreen agent provider settings/config/runtime
- shared provider and transport abstractions
- a server-side integration layer for local Codex detection/auth/session reuse
- related AGENTS documentation in the SpaceAgent repo, because that repo treats AGENTS files as part of the implementation contract

## Suggested Breakdown

1. Add a new provider enum/value for `Subscription` in both chat systems.
2. Extend persisted settings so both surfaces can store subscription-provider selection and any needed provider metadata.
3. Update both settings dialogs to show a third provider tab/section.
4. Add status-loading UI for Codex installation/auth state.
5. Add actions to:
   - detect Codex
   - refresh status
   - initiate Codex login
6. Implement a narrow backend/local integration layer that:
   - detects whether Codex is installed
   - checks login status
   - initiates login if needed
   - safely enables SpaceAgent to use the authenticated subscription-backed path
7. Add a SpaceAgent-side transport adapter so chats using `Subscription` still run through SpaceAgent's own harness and only swap the final model transport.
8. Expose subscription-backed models in the provider UI.
9. Verify the full flow in both:
   - admin chat
   - onscreen agent overlay
10. Update the relevant AGENTS docs in the SpaceAgent repo for all changed scopes.

## Constraints To Preserve

- Keep SpaceAgent browser-first where possible, but this feature will likely require a narrow backend/local-machine seam.
- The backend change should stay minimal and infrastructure-focused.
- Do not collapse this into an external generic bridge unless absolutely necessary.
- Preserve SpaceAgent's own prompt/history/skills/tooling behavior.
- Codex installation should be treated as required for this provider.

## Success Criteria

The work is successful when:

- SpaceAgent shows a `Subscription` provider in both chat surfaces
- a user with Codex installed can authenticate through Codex
- an already-authenticated Codex installation is reused automatically when possible
- SpaceAgent can send chats through subscription-backed inference without using the Codex harness
- SpaceAgent still behaves like SpaceAgent, not like Codex

## First Prompt To Use In The New Session

Use this prompt in the new session:

Implement the native `Subscription` provider for SpaceAgent as described in this file. The provider must appear in both the admin chat and the onscreen agent overlay, must require a local Codex installation, must reuse existing Codex ChatGPT login when available, must initiate Codex-backed login when needed, and must let SpaceAgent use ChatGPT subscription-backed inference without switching to the Codex harness. Start by reading the relevant AGENTS files in the SpaceAgent repo, then inspect the existing provider/settings/runtime flow for both chat surfaces, then propose the exact implementation plan before changing code.
