document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // 1. Copy to Clipboard Functionality
  // ==========================================
  const copyBtn = document.getElementById('copy-btn');
  const npmCommand = document.getElementById('npm-command');

  if (copyBtn && npmCommand) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(npmCommand.innerText);
        
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
  // 2. Getting Started Tab Switcher
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
  // 3. Theme Toggle (Dark / Light Mode)
  // ==========================================
  const themeToggle = document.getElementById('theme-toggle');
  
  if (themeToggle) {
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
    
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
});
