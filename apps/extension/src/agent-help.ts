import { buildAgentPrompt } from '@oit/agent-prompts';

/** A user-triggered copy only; setup commands are never executed by the extension. */
export function bindAgentHelp() {
  const button = document.getElementById('copy-agent') as HTMLButtonElement | null;
  const prompt = document.getElementById('agent-prompt') as HTMLTextAreaElement | null;
  const preview = document.getElementById('agent-preview') as HTMLDetailsElement | null;
  const message = document.getElementById('agent-copy-status');
  if (!button || !prompt || !preview || !message) return;
  prompt.value = buildAgentPrompt({ kind: 'website', locale: 'en' });
  button.addEventListener('click', () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(prompt.value);
        message.textContent = 'Copied. Paste this into Codex or your coding agent.';
      } catch {
        preview.open = true;
        prompt.focus(); prompt.select();
        message.textContent = 'Copy the selected text, then paste it into your agent.';
      }
    })();
  });
}
