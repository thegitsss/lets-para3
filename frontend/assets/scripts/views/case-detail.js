document.addEventListener('DOMContentLoaded', () => {
  // === Notes auto-save ===
  const notesField = document.getElementById('notesField');
  const saveBtn = document.getElementById('saveBtn');

  saveBtn?.addEventListener('click', () => {
    const content = notesField?.value.trim();
    if (!content) {
      alert('Please enter a note before saving.');
      return;
    }
    localStorage.setItem('caseNotes', content);
    alert('Notes saved successfully!');
  });

  // === File upload simulation ===
  const uploadBtn = document.getElementById('uploadBtn');
  uploadBtn?.addEventListener('click', () => {
    alert('File upload feature coming soon (integrate cloud storage here).');
  });

  // === Post New Job (pre-filled draft) ===
  const newJobBtn = document.getElementById('newJobBtn');
  newJobBtn?.addEventListener('click', () => {
    const confirmNewJob = confirm('Would you like to post a new related job?');
    if (confirmNewJob) {
      window.location.href = 'create-case.html';
    }
  });

  // === Complete Case confirmation modal ===
  const completeCaseBtn = document.getElementById('completeCaseBtn');
  completeCaseBtn?.addEventListener('click', () => {
    const confirmClose = confirm('Are you sure you want to mark this case as complete? This will archive it.');
    if (confirmClose) {
      alert('Case marked as completed and moved to Archived Cases.');
      window.location.href = 'active-cases.html';
    }
  });

  // === Launch Zoom/Teams call ===
  const meetingBtn = document.getElementById('meetingBtn');
  meetingBtn?.addEventListener('click', () => {
    const platform = prompt('Enter preferred meeting platform (Zoom / Teams / Meet):', 'Zoom');
    if (!platform) return;

    const zoomURL = 'https://zoom.us/';
    const teamsURL = 'https://teams.microsoft.com/';
    const meetURL = 'https://meet.google.com/';

    switch (platform.toLowerCase()) {
      case 'zoom': window.open(zoomURL, '_blank'); break;
      case 'teams': window.open(teamsURL, '_blank'); break;
      case 'meet': window.open(meetURL, '_blank'); break;
      default: alert('Unsupported platform.');
    }
  });
});
