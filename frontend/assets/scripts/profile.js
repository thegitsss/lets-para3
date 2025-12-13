let cropper;
let saveTimer = null;
let uploading = false;
let uploaderObserver = null;
const showToast = window.showToast || ((message, type = "info") => {
    if (window.toastUtils?.show) {
        window.toastUtils.show(message, { type });
    } else {
        console[type === "error" ? "error" : "log"](message);
    }
});

function initProfileUploader() {
    const input = document.getElementById("profile-photo-input");
    const preview = document.getElementById("profile-photo-preview");
    const saveBtn = document.getElementById("save-profile-photo-btn");
    const uploadBtn = document.getElementById("upload-profile-photo-btn");
    const clusterAvatar = document.getElementById("clusterAvatar");

    if (!input || !preview) return;
    if (input.dataset.bound === "true") return;
    input.dataset.bound = "true";

    if (uploadBtn) {
        uploadBtn.addEventListener("click", () => input.click());
    }

    if (saveBtn) {
        saveBtn.style.display = "inline-block";
        saveBtn.addEventListener("click", () => saveCroppedPhoto(true));
    }

    const debouncedSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveCroppedPhoto, 250);
    };

    async function saveCroppedPhoto(force = false) {
        if (!cropper || uploading) return;
        uploading = true;

        const canvas = cropper.getCroppedCanvas({
            width: 600,
            height: 600,
            imageSmoothingQuality: "high",
        });
        if (!canvas) {
            uploading = false;
            return;
        }

        const base64 = canvas.toDataURL("image/jpeg");

        try {
            const response = await fetch("/api/users/profile-photo", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: localStorage.getItem("token") ? `Bearer ${localStorage.getItem("token")}` : undefined,
                },
                credentials: "include",
                body: JSON.stringify({ image: base64 }),
            });

            if (!response.ok) {
                throw new Error(`Upload failed (${response.status})`);
            }

            const data = await response.json();

            if (data.success && data.url) {
                document.querySelectorAll(".nav-profile-photo").forEach(img => {
                    img.src = data.url;
                });
                document.querySelectorAll(".globalProfileImage").forEach(img => {
                    img.src = data.url;
                });
                if (clusterAvatar) clusterAvatar.src = data.url;
                const previewImg = preview.querySelector("img");
                if (previewImg) previewImg.src = data.url;
                if (saveBtn) saveBtn.textContent = "Saved";
            } else {
                console.error("Profile photo upload failed", data);
                if (force) alert("Unable to save profile photo. Please try again.");
            }
        } catch (err) {
            console.error("Profile photo upload failed", err);
            if (force) alert("Unable to save profile photo. Please try again.");
        } finally {
            uploading = false;
        }
    }

    input.addEventListener("change", () => {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            preview.innerHTML = `<img id="crop-image" src="${e.target.result}" style="max-width:100%;">`;

            if (cropper) cropper.destroy();

            cropper = new Cropper(document.getElementById("crop-image"), {
                aspectRatio: 1,
                viewMode: 2,
                dragMode: "move",
                background: false,
                cropend: debouncedSave,
                ready: debouncedSave
            });

            setTimeout(() => saveCroppedPhoto(), 300);
        };

        reader.readAsDataURL(file);
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initProfileUploader();
    uploaderObserver = new MutationObserver(() => initProfileUploader());
    uploaderObserver.observe(document.body, { childList: true, subtree: true });
    initAttorneySettings();
});

function getAttorneyUser() {
    if (window.currentUser) return window.currentUser;
    try {
        const raw = localStorage.getItem("lpc_user");
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function initAttorneySettings() {
    const container = document.getElementById("attorneySettings");
    if (!container) return;
    const user = getAttorneyUser();
    if (!user || (user.role && user.role !== "attorney")) return;

    const first = document.getElementById("attorneyFirstName");
    const last = document.getElementById("attorneyLastName");
    const email = document.getElementById("attorneyEmail");
    const linkedIn = document.getElementById("attorneyLinkedIn");
    const firmName = document.getElementById("attorneyFirmName");
    const firmWebsite = document.getElementById("attorneyFirmWebsite");
    const practice = document.getElementById("attorneyPracticeDescription");

    if (first) first.value = user.firstName || "";
    if (last) last.value = user.lastName || "";
    if (email) email.value = user.email || "";
    if (linkedIn) linkedIn.value = user.linkedInURL || "";
    if (firmName) firmName.value = user.firmName || user.lawFirm || "";
    if (firmWebsite) firmWebsite.value = user.firmWebsite || "";
    if (practice) practice.value = user.practiceDescription || user.bio || "";

    const prefs = user.notificationPrefs || {};
    const emailToggle = document.getElementById("attorneyEmailNotifications");
    const messageToggle = document.getElementById("attorneyMessageAlerts");
    const caseToggle = document.getElementById("attorneyCaseUpdates");
    if (emailToggle) emailToggle.checked = !!(prefs.emailNotifications ?? prefs.email);
    if (messageToggle) messageToggle.checked = !!(prefs.messageAlerts ?? prefs.emailMessages);
    if (caseToggle) caseToggle.checked = !!(prefs.caseUpdates ?? prefs.emailCase);

    const saveBtn = document.getElementById("saveAttorneyProfile");
    if (saveBtn && !saveBtn.dataset.bound) {
        saveBtn.dataset.bound = "true";
        saveBtn.addEventListener("click", saveAttorneyProfile);
    }
}

async function saveAttorneyProfile() {
    const saveBtn = document.getElementById("saveAttorneyProfile");
    if (saveBtn) saveBtn.disabled = true;

    const payload = {
        firstName: document.getElementById("attorneyFirstName")?.value || "",
        lastName: document.getElementById("attorneyLastName")?.value || "",
        linkedInURL: document.getElementById("attorneyLinkedIn")?.value || "",
        firmName: document.getElementById("attorneyFirmName")?.value || "",
        firmWebsite: document.getElementById("attorneyFirmWebsite")?.value || "",
        practiceDescription: document.getElementById("attorneyPracticeDescription")?.value || "",
        notificationPrefs: {
            emailNotifications: document.getElementById("attorneyEmailNotifications")?.checked || false,
            messageAlerts: document.getElementById("attorneyMessageAlerts")?.checked || false,
            caseUpdates: document.getElementById("attorneyCaseUpdates")?.checked || false
        }
    };

    try {
        const res = await fetch("/api/users/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Failed to save");

        if (window.currentUser && typeof window.currentUser === "object") {
            window.currentUser = { ...window.currentUser, ...payload, notificationPrefs: { ...window.currentUser.notificationPrefs, ...payload.notificationPrefs } };
        }
        showToast("Profile updated successfully.");
    } catch (err) {
        console.error(err);
        showToast("Unable to save profile.", "error");
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}
