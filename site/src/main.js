import autoAnimate from '@formkit/auto-animate';
import './style.css';

const explanations = [
  ['01 / SEARCH', 'Find the capability, not the schema.', 'Hybrid lexical + semantic retrieval returns ranked action IDs and concise descriptions. Discovery does not activate the downstream server.'],
  ['02 / LOAD', 'Bring in only what you need.', 'Fetch the original upstream JSON Schema for the selected action. It arrives as a tool result, not a changing host-visible tool definition.'],
  ['03 / EXECUTE', 'Validate. Authorize. Route.', 'Validate arguments against the upstream schema, apply policy and approval gates, then dispatch to the owning server. Downstream activation is lazy.'],
];
const panel = document.querySelector('#step-detail');
const controls = [...document.querySelectorAll('[data-step]')];
autoAnimate(panel, { duration: 180 });
for (const button of controls) {
  button.addEventListener('click', () => {
    for (const control of controls) control.setAttribute('aria-pressed', String(control === button));
    const nodes = explanations[Number(button.dataset.step)].map((text, index) => {
      const node = document.createElement(index === 0 ? 'span' : index === 1 ? 'h3' : 'p');
      if (index === 0) node.className = 'eyebrow';
      node.textContent = text;
      return node;
    });
    panel.replaceChildren(...nodes);
  });
}

const copyButton = document.querySelector('#copy-install');
copyButton.hidden = !navigator.clipboard;
copyButton.addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);
    status.textContent = 'Copied to clipboard.';
  } catch {
    status.textContent = 'Copy unavailable. Select the command below.';
  }
});
