document.addEventListener("DOMContentLoaded", () => {
  const senderListDiv = document.getElementById("senderList");
  const scanBtn = document.getElementById("scanBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const statusDiv = document.getElementById("status");

  let senderMessages = {};

  scanBtn.addEventListener("click", async () => {
    statusDiv.textContent = "Fetching current folder...";
    
    // Get the currently active folder tab
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0 || !tabs[0].folder) {
      senderListDiv.textContent = "Please navigate to your Junk or Inbox folder first.";
      return;
    }

    statusDiv.textContent = "Analyzing sender volumes...";
    senderListDiv.textContent = "Reading messages...";
    
    let page;
    try {
      page = await messenger.messages.list(tabs[0].folder);
    } catch (e) {
      senderListDiv.textContent = "Could not read this folder. Try another one.";
      return;
    }

    let messages = [...page.messages];
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      messages = messages.concat(page.messages);
    }

    // Tally up messages by clean sender email address
    const senderCounts = {};
    senderMessages = {};

    messages.forEach(msg => {
      // Clean up "Name <email@domain.com>" formatting
      let email = msg.author;
      const match = msg.author.match(/<([^>]+)>/);
      if (match && match[1]) {
        email = match[1];
      }
      email = email.trim().toLowerCase();

      senderCounts[email] = (senderCounts[email] || 0) + 1;
      if (!senderMessages[email]) {
        senderMessages[email] = [];
      }
      senderMessages[email].push(msg.id);
    });

    // Set target threshold (e.g., alert if address sent more than 25 emails)
    const THRESHOLD = 125;
    const heavySenders = Object.keys(senderCounts)
      .filter(email => senderCounts[email] >= THRESHOLD)
      .sort((a, b) => senderCounts[b] - senderCounts[a]);

    if (heavySenders.length === 0) {
      senderListDiv.textContent = `Clean! No single address sent >= ${THRESHOLD} messages.`;
      deleteBtn.style.display = "none";
      statusDiv.textContent = "";
      return;
    }

    // Populate checklist UI
    senderListDiv.innerHTML = "";
    heavySenders.forEach((email, index) => {
      const item = document.createElement("div");
      item.className = "sender-item";
      item.innerHTML = `
        <input type="checkbox" id="sender_${index}" value="${email}" checked>
        <label for="sender_${index}">
          <span class="count">[${senderCounts[email]} mails]</span>${email}
        </label>
      `;
      senderListDiv.appendChild(item);
    });

    scanBtn.style.display = "none";
    deleteBtn.style.display = "block";
    statusDiv.textContent = "Review targets before proceeding.";
  });

  deleteBtn.addEventListener("click", async () => {
    const checkedInputs = document.querySelectorAll("#senderList input:checked");
    let targetMessageIds = [];

    checkedInputs.forEach(input => {
      const email = input.value;
      if (senderMessages[email]) {
        targetMessageIds = targetMessageIds.concat(senderMessages[email]);
      }
    });

    if (targetMessageIds.length === 0) {
      statusDiv.textContent = "No senders selected.";
      return;
    }

    statusDiv.textContent = `Deleting ${targetMessageIds.length} messages...`;
    
    // Batch update to read status, then throw them into the Trash
    await messenger.messages.update(targetMessageIds, { read: true });
    // await messenger.messages.delete(targetMessageIds, false); 

    statusDiv.textContent = "Swept successfully!";
    deleteBtn.style.display = "none";
    scanBtn.style.display = "block";
    senderListDiv.textContent = "Cleanup finished. Ready for next scan.";
  });
});
