document.addEventListener('DOMContentLoaded', () => {
  // 1. Copy to clipboard functionality
  const copyBtn = document.getElementById('copy-btn');
  const npmCommand = document.getElementById('npm-command');

  if (copyBtn && npmCommand) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(npmCommand.innerText);
        
        // Visual feedback
        const originalIcon = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #27c93f;"></i>';
        
        setTimeout(() => {
          copyBtn.innerHTML = originalIcon;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    });
  }

  // 2. Scroll Reveal Animations
  // Uses IntersectionObserver to trigger CSS transitions when elements enter viewport
  const revealElements = document.querySelectorAll('.reveal');

  const revealOptions = {
    threshold: 0.15,
    rootMargin: "0px 0px -50px 0px"
  };

  const revealOnScroll = new IntersectionObserver(function(entries, observer) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      } else {
        entry.target.classList.add('active');
        observer.unobserve(entry.target); // Stop observing once revealed
      }
    });
  }, revealOptions);

  revealElements.forEach(el => {
    revealOnScroll.observe(el);
  });
});
