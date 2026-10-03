// Fade sections in as they scroll into view (skipped automatically when the
// user prefers reduced motion — see styles.css).
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }
}, { threshold: 0.15 });

document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

document.getElementById('year').textContent = new Date().getFullYear();
