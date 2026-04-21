// audit-webhook.js
(function() {
  const WEBHOOK_URL = 'https://www.infinitecore.net/api/webhooks/padde-ci';

  // Cherche automatiquement le formulaire d'audit dans la page
  const form = document.querySelector('form');
  if (!form) return;

  form.addEventListener('submit', async function(e) {
    e.preventDefault();

    const bouton = form.querySelector('button[type="submit"], input[type="submit"]');
    const texteOriginal = bouton ? (bouton.textContent || bouton.value) : '';

    if (bouton) {
      bouton.disabled = true;
      if (bouton.textContent !== undefined) bouton.textContent = 'Envoi en cours...';
      else bouton.value = 'Envoi en cours...';
    }

    // Récupère tous les champs du formulaire
    const donnees = {};
    new FormData(form).forEach(function(valeur, cle) {
      donnees[cle] = valeur;
    });

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(donnees)
      });

      if (response.ok) {
        window.location.href = 'https://www.infinitecore.net';
      } else {
        alert('Une erreur est survenue. Veuillez réessayer.');
        if (bouton) {
          bouton.disabled = false;
          if (bouton.textContent !== undefined) bouton.textContent = texteOriginal;
          else bouton.value = texteOriginal;
        }
      }
    } catch (error) {
      alert('Impossible d\'envoyer. Vérifiez votre connexion.');
      if (bouton) {
        bouton.disabled = false;
        if (bouton.textContent !== undefined) bouton.textContent = texteOriginal;
        else bouton.value = texteOriginal;
      }
    }
  });
})();
