let cropper;
let saveTimer = null;
let uploading = false;
let uploaderObserver = null;

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
});
