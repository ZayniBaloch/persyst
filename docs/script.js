document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // 1. Copy to Clipboard (Primary Install Box)
  // ==========================================
  const copyBtn = document.getElementById('copy-btn');
  const npmCommand = document.getElementById('npm-command');

  if (copyBtn && npmCommand) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(npmCommand.innerText.trim());
        
        // Visual feedback using Feather check icon
        copyBtn.innerHTML = '<i data-feather="check" class="icon-sm" style="color: #10b981;"></i>';
        feather.replace();
        
        setTimeout(() => {
          copyBtn.innerHTML = '<i data-feather="copy" class="icon-sm"></i>';
          feather.replace();
        }, 2000);
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    });
  }

  // ==========================================
  // 2. Setup Config code-block copy buttons
  // ==========================================
  const copyCodeButtons = document.querySelectorAll('.copy-code-btn');
  copyCodeButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-clipboard');
      const targetCode = document.getElementById(targetId);
      if (targetCode) {
        try {
          await navigator.clipboard.writeText(targetCode.innerText.trim());
          
          btn.innerHTML = '<i data-feather="check" class="icon-sm" style="color: #10b981;"></i>';
          feather.replace();
          
          setTimeout(() => {
            btn.innerHTML = '<i data-feather="copy" class="icon-sm"></i>';
            feather.replace();
          }, 2000);
        } catch (err) {
          console.error('Failed to copy code: ', err);
        }
      }
    });
  });

  // ==========================================
  // 3. Getting Started Tab Switcher
  // ==========================================
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all buttons & panes
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      // Activate selected button & pane
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });

  // ==========================================
  // 4. Interactive Terminal Sandbox Switcher
  // ==========================================
  const sandboxBtns = document.querySelectorAll('.sandbox-btn');
  const terminalPanes = document.querySelectorAll('.terminal-pane');
  const terminalFilename = document.getElementById('terminal-filename');

  const fileMap = {
    'term-query': 'mcp-rpc-request.json',
    'term-contradict': 'mcp-rpc-response.json',
    'term-audit': 'verify-attestation.log',
    'term-remember': 'remember-bypass.log'
  };

  sandboxBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all buttons & panes
      sandboxBtns.forEach(b => b.classList.remove('active'));
      terminalPanes.forEach(p => p.classList.remove('active'));

      // Activate selected button & pane
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-terminal');
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      // Update filename in window header
      if (terminalFilename && fileMap[targetId]) {
        terminalFilename.textContent = fileMap[targetId];
      }
    });
  });

  // ==========================================
  // 5. Theme Toggle (Dark / Light Mode)
  // ==========================================
  const themeToggle = document.getElementById('theme-toggle');
  
  if (themeToggle) {
    const savedTheme = localStorage.getItem('theme');
    const initialTheme = savedTheme || 'light';
    
    setTheme(initialTheme);
    
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
    });
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    
    if (themeToggle) {
      if (theme === 'dark') {
        themeToggle.innerHTML = '<i data-feather="sun" class="theme-icon"></i>';
      } else {
        themeToggle.innerHTML = '<i data-feather="moon" class="theme-icon"></i>';
      }
      feather.replace();
    }
  }

  // ==========================================
  // 6. Developer SDK Tab Switcher
  // ==========================================
  const sdkTabButtons = document.querySelectorAll('.sdk-tab-btn');
  const sdkTabPanes = document.querySelectorAll('.sdk-tab-pane');

  sdkTabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all buttons & panes
      sdkTabButtons.forEach(b => b.classList.remove('active'));
      sdkTabPanes.forEach(p => p.classList.remove('active'));

      // Activate selected button & pane
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-sdk-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });
});
