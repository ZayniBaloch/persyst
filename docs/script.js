document.addEventListener('DOMContentLoaded', () => {
  // Copy to clipboard functionality
  const copyBtn = document.getElementById('copy-btn');
  const npmCommand = document.getElementById('npm-command');

  if (copyBtn && npmCommand) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(npmCommand.innerText);
        
        // Visual feedback using Feather icons
        const originalIcon = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i data-feather="check" style="color: #10b981;"></i>';
        feather.replace(); // re-render the new icon
        
        setTimeout(() => {
          copyBtn.innerHTML = originalIcon;
          feather.replace();
        }, 2000);
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    });
  }
});
