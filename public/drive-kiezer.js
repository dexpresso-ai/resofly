// De kiezer van Google Drive (zie drive-kiezer.html).
//
// Rondgang:
//   1. Deze pagina meldt 'ready' aan de app (alleen aan de eigen herkomst).
//   2. De app stuurt 'open' met het korte token, de browsersleutel en het
//      projectnummer van de Google-app.
//   3. Deze pagina laadt het script van Google en opent de kiezer.
//   4. Bij kiezen: 'picked' met alleen de id's. De server vraagt de rest zelf
//      bij Google op; wat de browser zegt over naam of link telt niet.
//   5. Bij annuleren of een fout: 'cancel' of 'error'.
(function () {
  'use strict';

  var origin = window.location.origin;
  var started = false;
  var melding = document.getElementById('melding');

  function send(message) {
    message.source = 'resofly-drive-kiezer';
    window.parent.postMessage(message, origin);
  }

  function toon(text) {
    if (!melding) return;
    if (text) { melding.textContent = text; melding.hidden = false; } else { melding.hidden = true; }
  }

  function fout(text) {
    toon(text);
    send({ type: 'error', message: text });
  }

  function laadScript(src, klaar) {
    var script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = function () { klaar(null); };
    script.onerror = function () { klaar(new Error('laden mislukt')); };
    document.head.appendChild(script);
  }

  function openKiezer(cfg) {
    var g = window.google;
    if (!g || !g.picker) { fout('Google Drive kon niet laden. Probeer het opnieuw.'); return; }
    var picker = g.picker;
    // Je eigen Drive, en de gedeelde Drives van je organisatie. Mappen zie je om
    // erin te kunnen kijken; kiezen doe je bestanden.
    var mijn = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(picker.DocsViewMode.LIST);
    var gedeeld = new picker.DocsView(picker.ViewId.DOCS)
      .setEnableDrives(true)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(picker.DocsViewMode.LIST);
    var kiezer = new picker.PickerBuilder()
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setOrigin(origin)
      .setLocale('nl')
      .setTitle('Kies bestanden voor ResoFly')
      .addView(mijn)
      .addView(gedeeld)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setMaxItems(Math.max(1, Math.min(50, Number(cfg.maxItems) || 50)))
      .setCallback(function (data) {
        var action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          var docs = data[picker.Response.DOCUMENTS] || [];
          var files = [];
          for (var i = 0; i < docs.length; i++) {
            var id = docs[i][picker.Document.ID];
            if (typeof id === 'string' && /^[A-Za-z0-9_\-]{1,512}$/.test(id)) files.push({ id: id });
          }
          send({ type: 'picked', files: files });
        } else if (action === picker.Action.CANCEL) {
          send({ type: 'cancel' });
        }
      })
      .build();
    toon('');
    kiezer.setVisible(true);
    send({ type: 'shown' });
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== origin || event.source !== window.parent) return;
    var data = event.data || {};
    if (data.source !== 'resofly-app' || data.type !== 'open' || started) return;
    if (typeof data.accessToken !== 'string' || typeof data.apiKey !== 'string' || typeof data.appId !== 'string') {
      fout('De kiezer kreeg geen geldige gegevens.');
      return;
    }
    started = true;
    laadScript('https://apis.google.com/js/api.js', function (err) {
      if (err || !window.gapi) { fout('Google Drive kon niet laden. Controleer je verbinding en probeer het opnieuw.'); return; }
      window.gapi.load('picker', {
        callback: function () { openKiezer(data); },
        onerror: function () { fout('Google Drive kon niet laden. Probeer het opnieuw.'); },
        timeout: 20000,
        ontimeout: function () { fout('Google Drive reageerde niet. Probeer het opnieuw.'); },
      });
    });
  });

  send({ type: 'ready' });
})();
