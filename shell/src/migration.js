    let selectedPath = null;
    let isMigrating = false;

    document.getElementById('btn-browse').addEventListener('click', async () => {
      const path = await window.migration.selectDirectory();
      if (path) {
        selectedPath = path;
        document.getElementById('dir-input').value = path;
        document.getElementById('btn-continue').disabled = false;
        document.getElementById('error-message').style.display = 'none';
      }
    });

    document.getElementById('btn-quit').addEventListener('click', () => {
      window.migration.cancel();
    });

    document.getElementById('btn-cancel-migration').addEventListener('click', () => {
      if (isMigrating && confirm('Are you sure you want to cancel? This will abort the setup.')) {
        window.migration.cancel();
      }
    });

    document.getElementById('btn-continue').addEventListener('click', async () => {
      if (!selectedPath) return;

      document.getElementById('screen-welcome').classList.remove('active');
      document.getElementById('screen-progress').classList.add('active');
      isMigrating = true;

      try {
        const res = await window.migration.start(selectedPath);
        if (res && res.ok === false) {
          const message = res.reason === "destination-occupied"
            ? "The selected directory is not empty. Please choose an empty directory for your workspace."
            : (res.reason ? `Migration rejected: ${res.reason}` : "Migration failed");
          throw new Error(message);
        }
        // If it resolves successfully, main.js will close the window.
      } catch (err) {
        isMigrating = false;
        document.getElementById('screen-progress').classList.remove('active');
        document.getElementById('screen-welcome').classList.add('active');
        const errBox = document.getElementById('error-message');
        errBox.textContent = err.message || String(err);
        errBox.style.display = 'block';
      }
    });

    window.migration.onProgress((event, data) => {
      if (data.step) document.getElementById('status-text').textContent = data.step;
      if (data.percent !== undefined) {
        document.getElementById('progress-fill').style.width = `${data.percent}%`;
      }
      if (data.title) {
        document.getElementById('progress-title').textContent = data.title;
      }
    });
