const reasons = {
  cancelled: 'Slack sign-in was cancelled.',
  expired: 'That sign-in link expired. Start again from the home page.',
  exchange: "Slack didn't accept the sign-in. Try again.",
  workspace: 'This bot only works in its own Slack workspace.',
  scopes: "Some permissions weren't granted. Try again and approve all of them.",
  notfound: "That page doesn't exist.",
};

function buildModel(model) {
  const face = model.querySelector('.face');
  const text = face.textContent;
  const count = Number(model.dataset.layers) || 16;

  const back = document.createElement('span');
  back.className = 'layer back';
  back.textContent = text;
  model.insertBefore(back, face);

  for (let i = count; i >= 1; i--) {
    const side = document.createElement('span');
    side.className = 'layer side';
    side.textContent = text;
    side.style.setProperty('--i', i);
    model.insertBefore(side, face);
  }
}

document.querySelectorAll('.model').forEach(buildModel);

const reasonEl = document.getElementById('reason');
const reason = new URLSearchParams(location.search).get('reason') ?? (location.pathname === '/error' ? null : 'notfound');
if (reasonEl && reasons[reason]) reasonEl.textContent = reasons[reason];

const statusEl = document.getElementById('status');

if (statusEl) {
  fetch('/api/session', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then(({ connected, siren }) => {
      const heading = document.getElementById('allows');
      if (siren && heading) {
        const img = Object.assign(document.createElement('img'), { className: 'emoji', src: siren, alt: ':siren1:', title: ':siren1:' });
        img.addEventListener('error', () => img.remove(), { once: true });
        heading.append(' ', img);
      }
      
      if (!connected) return;
      document.getElementById('status-hint').remove();
      statusEl.prepend("You're connected to Slack · ");
    })
    .catch(() => {});
}
