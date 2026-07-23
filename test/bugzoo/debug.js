// bugzoo debug fixture — named handlers with locals for the M4 debug-plane proof.
function onPrimary() {
  const total = 21;
  const doubled = total * 2;
  window.__primaryResult = doubled;
  document.getElementById('resultbtn').textContent = 'primary-done-' + doubled;
  document.title = 'primary:' + doubled;
}
function onSecondary() {
  const note = 'secondary-ran';
  window.__secondaryResult = note;
  document.getElementById('resultbtn').textContent = 'secondary-done';
}
document.getElementById('primary').addEventListener('click', onPrimary);
document.getElementById('secondary').addEventListener('click', onSecondary);
