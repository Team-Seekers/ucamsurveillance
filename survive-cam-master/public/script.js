document.addEventListener("DOMContentLoaded", () => {
  const cameraFeed = document.getElementById("cameraFeed");
  const noConnectionFeed = document.getElementById("noConnectionFeed");
  const toastContainer = document.getElementById("toastContainer");
  const cameraStatusText = document.getElementById("cameraStatusText");
  const currentStatus = document.getElementById("currentStatus");
  const uptimeElement = document.getElementById("cameraUptime");
  const lastConnectionTimeElement =
    document.getElementById("lastConnectionTime");
  const alertsContainer = document.getElementById("alertsContainer");
  const emailToggle = document.getElementById("emailToggle");
  const smsToggle = document.getElementById("smsToggle");
  const webToggle = document.getElementById("webToggle");
  const cameraToggle = document.getElementById("cameraToggle");

  // Modal elements
  const editModal = document.getElementById("editModal");
  const closeModalButton = document.getElementById("closeModal");
  const cancelEditButton = document.getElementById("cancelEdit");
  const editForm = document.getElementById("editForm");
  const contactInput = document.getElementById("contactInput");
  const editContactButtons = document.querySelectorAll(".edit-contact-btn");
  const userEmailDisplay = document.getElementById("userEmailDisplay");
  const userPhoneDisplay = document.getElementById("userPhoneDisplay");

  let currentEditingField = "";

  const port = window.location.port || "3000";
  let websocket = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 3000;

  let allAlerts = [];
  let currentAlertType = "human_detection";
  const STORAGE_KEY = "camera_alerts";
  let isCameraEnabled = cameraToggle.checked; // Reflects the state of the UI toggle
  let monitoringInterval = null;

  let isTimeRangeActive =
    document.getElementById("timeRangeToggle")?.checked || false;
  let startTime = document.getElementById("startTime")?.value || "00:00";
  let endTime = document.getElementById("endTime")?.value || "23:59";

  // --- NEW: Read userdetails from data attribute ---
  let initialUserDetails = null;
  const appDataElement = document.getElementById("app-data");
  if (appDataElement && appDataElement.dataset.userDetails) {
    try {
      initialUserDetails = JSON.parse(appDataElement.dataset.userDetails);
      console.log(
        "Initial user details loaded from data attribute:",
        initialUserDetails
      );
    } catch (e) {
      console.error("Error parsing user details from data attribute:", e);
      showToast("Error loading user data.", "error");
    }
  }

  let lastAlertUpdateTime = 0; // Add this at the top with other state variables

  // Load alerts from sessionStorage on page load
  function loadAlertsFromStorage() {
    const storedAlerts = sessionStorage.getItem(STORAGE_KEY);
    if (storedAlerts) {
      allAlerts = JSON.parse(storedAlerts);
      updateAlerts();
    }
  }

  // Save alerts to sessionStorage
  function saveAlertsToStorage(alerts) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  }

  // Unified function to update camera UI status
  function updateCameraUIStatus(isOnline, uptime = null) {
    console.log(
      `[updateCameraUIStatus] Called with isOnline: ${isOnline}, current isCameraEnabled: ${isCameraEnabled}`
    );
    if (cameraStatusText) {
      cameraStatusText.textContent = isOnline ? "• Online" : "• Offline";
      cameraStatusText.className = isOnline
        ? "text-sm text-green-400"
        : "text-sm text-red-400";
      console.log(
        `[updateCameraUIStatus] cameraStatusText set to: ${cameraStatusText.textContent}`
      );
    }
    if (currentStatus) {
      currentStatus.textContent = isOnline ? "Online" : "Offline";
      currentStatus.className = isOnline
        ? "font-semibold text-green-400"
        : "font-semibold text-red-400";
      console.log(
        `[updateCameraUIStatus] currentStatus set to: ${currentStatus.textContent}`
      );
    }
    if (uptimeElement && isOnline) {
      uptimeElement.textContent = `Uptime: ${uptime} minutes`;
    } else if (uptimeElement && !isOnline) {
      uptimeElement.textContent = `Uptime: N/A`; // Clear uptime when offline
    }
    if (lastConnectionTimeElement && isOnline) {
      const now = new Date();
      lastConnectionTimeElement.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (lastConnectionTimeElement && !isOnline) {
      lastConnectionTimeElement.textContent = `Offline`; // Clear last updated when offline
    }

    if (cameraFeed && noConnectionFeed) {
      // Show cameraFeed only if it's online AND the toggle is enabled
      if (isOnline && isCameraEnabled) {
        cameraFeed.classList.remove("hidden");
        noConnectionFeed.classList.add("hidden");
        console.log("[updateCameraUIStatus] Showing cameraFeed.");
      } else {
        cameraFeed.classList.add("hidden");
        noConnectionFeed.classList.remove("hidden");
        console.log("[updateCameraUIStatus] Showing noConnectionFeed.");
      }
    }
  }

  function connectWebSocket() {
    console.log("[connectWebSocket] Attempting connection...");
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.hostname}:${port}`;
      console.log("Attempting to connect to WebSocket at:", wsUrl);

      websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        console.log("WebSocket connection established");
        showToast("Connection established", "success");
        reconnectAttempts = 0;

        // --- IMPORTANT: Send userdetails to the server via WebSocket ---
        if (initialUserDetails) {
          // Use the variable loaded from data attribute
          websocket.send(
            JSON.stringify({ type: "user_data", userData: initialUserDetails })
          );
          console.log("Sent initial user details to server via WebSocket.");
        } else {
          console.warn(
            "initialUserDetails not found. User data not sent to server via WebSocket."
          );
        }

        websocket.send(JSON.stringify({ type: "request_camera_status" }));
        // The camera status will be updated by the server's 'camera_status' message
        // Do not call updateCameraUIStatus(true) here directly, wait for server confirmation
        // if (isCameraEnabled && isWithinTimeRange()) {
        //     startMonitoring();
        // }
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("[WebSocket.onmessage] Received data:", data.type);

          switch (data.type) {
            case "camera_status":
              // This is the definitive source of truth for camera online/offline status
              updateCameraUIStatus(data.status.isOnline, data.status.uptime);
              // Also update isCameraEnabled based on server's status, if it's different
              if (
                cameraToggle &&
                cameraToggle.checked !== data.status.isEnabled
              ) {
                cameraToggle.checked = data.status.isEnabled;
                isCameraEnabled = data.status.isEnabled;
                console.log(
                  `[WebSocket.onmessage] Camera toggle adjusted to server state: ${isCameraEnabled}`
                );
              }

              // If camera is now online AND enabled, start monitoring
              if (
                data.status.isOnline &&
                data.status.isEnabled &&
                isWithinTimeRange()
              ) {
                startMonitoring();
              } else {
                stopMonitoring(); // Stop if offline, or disabled, or outside time range
              }

              const statusMessage = data.status.isOnline
                ? "Camera is online"
                : "Camera went offline";
              const statusColor = data.status.isOnline ? "green" : "red";
              const statusAlert = {
                type: "Camera Status",
                message: statusMessage,
                timestamp: new Date().toISOString(),
                color: statusColor,
              };
              // Prevent duplicate status alerts if the last one is the same
              if (
                allAlerts.length === 0 ||
                allAlerts[0].message !== statusAlert.message
              ) {
                allAlerts.unshift(statusAlert);
                if (allAlerts.length > 50) allAlerts.pop();
                saveAlertsToStorage(allAlerts);
                updateAlerts();
              }
              break;

            case "motion_detected":
              if (webToggle.checked) {
                const now = Date.now();
                // Only show toast and add alert if 10 seconds have passed since last update
                if (now - lastAlertUpdateTime >= 10000) {
                  showToast("Motion detected!", "warning");

                  if (data.data.imageData) {
                    updateCameraFeed(data.data.imageData);
                    const detectionAlert = {
                      type: "Human Detection",
                      message: `Person detected at ${data.data.detectionTime}`,
                      timestamp: new Date().toISOString(),
                      color: "red",
                      imageData: data.data.imageData,
                    };
                    allAlerts.unshift(detectionAlert);
                    if (allAlerts.length > 50) allAlerts.pop();
                    saveAlertsToStorage(allAlerts);
                    updateAlerts();
                    lastAlertUpdateTime = now; // Update the last alert time
                  }
                } else {
                  console.log(
                    `Skipping alert update - rate limit active. Next allowed in ${
                      10000 - (now - lastAlertUpdateTime)
                    }ms`
                  );
                }
              }
              break;
            case "status_update":
              // This case handles clearing web alerts when web notifications are turned off
              if (
                data.details &&
                data.details.type === "web" &&
                data.details.enabled === false &&
                data.status === "active"
              ) {
                allAlerts = allAlerts.filter(
                  (alert) => alert.type !== "Human Detection"
                );
                saveAlertsToStorage(allAlerts);
                updateAlerts();
                showToast("Web alerts cleared.", "info");
              }
              break;
            case "error":
              showToast(data.error, "error");
              break;
            case "limit_reached_notification": // Added for SMS limit notification
              if (data.limitType === "account_sms_daily") {
                showToast(data.message, "error");
              }
              break;
          }
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
          showToast("Error receiving camera data", "error");
        }
      };

      websocket.onclose = (event) => {
        console.log("WebSocket connection closed:", event.code, event.reason);
        handleConnectionLoss();
        updateCameraUIStatus(false); // Definitely set to offline on close
        if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          console.log(
            `Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
          );
          setTimeout(connectWebSocket, RECONNECT_DELAY);
        } else if (event.code === 1000) {
          showToast("Connection gracefully closed.", "success");
        } else {
          showToast("Failed to reconnect to camera.", "error");
        }
      };

      websocket.onerror = (error) => {
        console.error("WebSocket error:", error);
        handleConnectionLoss();
        updateCameraUIStatus(false); // Definitely set to offline on error
      };
    } catch (error) {
      console.error("Error creating WebSocket connection:", error);
      handleConnectionLoss();
      updateCameraUIStatus(false);
    }
  }

  connectWebSocket();

  let mediaStream = null;

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${
      type === "success"
        ? "bg-green-600"
        : type === "warning"
        ? "bg-yellow-600"
        : type === "info"
        ? "bg-blue-600"
        : "bg-red-600"
    } text-white p-3 rounded-lg shadow-lg flex items-center gap-2 transform translate-x-full transition-transform duration-300`;
    toast.innerHTML = `
            <i class="${
              type === "success"
                ? "ri-checkbox-circle-line"
                : type === "warning"
                ? "ri-error-warning-line"
                : type === "info"
                ? "ri-information-line"
                : "ri-close-circle-line"
            }"></i>
            <span>${message}</span>
        `;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.remove("translate-x-full");
      toast.classList.add("translate-x-0");
    }, 100);
    setTimeout(() => {
      toast.classList.remove("translate-x-0");
      toast.classList.add("translate-x-full");
      setTimeout(() => {
        toastContainer.removeChild(toast);
      }, 300);
    }, 3000);
  }

  async function initializeCamera() {
    console.log("[initializeCamera] Attempting to get camera stream...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      mediaStream = stream;
      cameraFeed.srcObject = stream;
      showToast("Camera access granted", "success");
      // Do not call updateCameraUIStatus(true) here.
      // Let the WebSocket 'camera_status' message from the server confirm online status.
      // However, we can start monitoring if conditions are met.
      if (isCameraEnabled && isWithinTimeRange()) {
        startMonitoring();
      }
      console.log("[initializeCamera] Camera stream obtained.");
    } catch (error) {
      console.error("Error accessing webcam:", error);
      handleCameraError();
      updateCameraUIStatus(false); // If camera access fails, definitely offline
    }
  }

  function handleCameraError() {
    console.log("[handleCameraError] Camera error detected.");
    cameraFeed.classList.add("hidden");
    noConnectionFeed.classList.remove("hidden");
    showToast("Camera access denied or unavailable", "error");
    stopMonitoring();
    isCameraEnabled = false; // Ensure the internal state is updated
    if (cameraToggle) cameraToggle.checked = false; // Visually update the toggle
  }

  function handleConnectionLoss() {
    console.log("[handleConnectionLoss] WebSocket connection lost.");
    stopMonitoring();
    showToast("Connection lost, attempting to reconnect...", "error");
  }

  function captureAndSendFrame() {
    if (
      !mediaStream ||
      websocket.readyState !== WebSocket.OPEN ||
      !isCameraEnabled ||
      !isWithinTimeRange()
    ) {
      console.log(
        "[captureAndSendFrame] Conditions not met for sending frame. Stopping monitoring."
      );
      stopMonitoring();
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = cameraFeed.videoWidth;
      canvas.height = cameraFeed.videoHeight;
      const context = canvas.getContext("2d");
      context.drawImage(cameraFeed, 0, 0, canvas.width, canvas.height);

      const imageData = canvas.toDataURL("image/jpeg", 0.7);
      websocket.send(
        JSON.stringify({ type: "image_frame", image_data: imageData })
      );
    } catch (error) {
      console.error("Error capturing frame:", error);
      showToast("Error capturing camera frame", "error");
      stopMonitoring();
    }
  }

  function startMonitoring() {
    if (
      websocket &&
      websocket.readyState === WebSocket.OPEN &&
      isCameraEnabled &&
      isWithinTimeRange()
    ) {
      if (!monitoringInterval) {
        monitoringInterval = setInterval(captureAndSendFrame, 200);
        showToast("Motion detection activated", "success");
        console.log("[startMonitoring] Monitoring started.");
      }
    } else {
      console.log(
        "[startMonitoring] Cannot start monitoring: conditions not met (WS open, camera enabled, time range active)."
      );
      stopMonitoring();
    }
  }

  function stopMonitoring() {
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
      showToast("Motion detection paused", "warning");
      console.log("[stopMonitoring] Monitoring paused.");
    }
  }

  function isWithinTimeRange() {
    if (!isTimeRangeActive) return false;

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);

    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    if (endMinutes < startMinutes) {
      return currentTime >= startMinutes || currentTime <= endMinutes;
    }

    return currentTime >= startMinutes && currentTime <= endMinutes;
  }

  function updateTimeRangeStatus() {
    const statusElement = document.getElementById("timeRangeStatus");
    if (!statusElement) return;

    if (!isTimeRangeActive) {
      statusElement.textContent = "Motion detection is currently inactive";
      statusElement.className = "text-red-500";
      stopMonitoring();
      return;
    }

    if (isWithinTimeRange()) {
      statusElement.textContent =
        startTime === "00:00" && endTime === "23:59"
          ? "Motion detection is active 24/7"
          : `Motion detection is active (${startTime} - ${endTime})`;
      statusElement.className = "text-green-500";
      if (isCameraEnabled) {
        // Only start monitoring if camera is also enabled
        startMonitoring();
      }
    } else {
      statusElement.textContent = `Motion detection is paused until ${startTime}`;
      statusElement.className = "text-yellow-500";
      stopMonitoring();
    }
  }

  function updateAlerts() {
    if (!alertsContainer) return;

    alertsContainer.innerHTML = "";

    const filteredAlerts = allAlerts.filter(
      (alert) =>
        alert.type === "Human Detection" || alert.type === "Camera Status"
    );

    if (filteredAlerts.length === 0) {
      const noAlerts = document.createElement("div");
      noAlerts.className = "text-center py-8";
      noAlerts.innerHTML = `
                <div class="w-12 h-12 bg-[#1a202e] rounded-full flex items-center justify-center mx-auto mb-3">
                    <i class="ri-user-line text-gray-500 text-xl"></i>
                </div>
                <p class="text-gray-400">No human detections yet</p>
            `;
      alertsContainer.appendChild(noAlerts);
      return;
    }

    filteredAlerts.forEach((alert) => {
      const newAlert = document.createElement("div");
      newAlert.className = `alert-item flex items-center justify-between p-3 bg-[#1a202e] rounded-lg border-l-4 border-${alert.color}-500 hover:bg-[#232b3d] transition-colors cursor-pointer mb-2`;

      const timestamp = new Date(alert.timestamp);
      const time = timestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const date = timestamp.toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });

      const timeAgo = getTimeAgo(timestamp);

      newAlert.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-${
                      alert.color
                    }-500/20 rounded-full flex items-center justify-center">
                        <i class="ri-${
                          alert.type === "Human Detection"
                            ? "user-line"
                            : "camera-line"
                        } text-${alert.color}-500"></i>
                    </div>
                    <div>
                        <div class="font-medium text-${alert.color}-500">${
        alert.type
      }</div>
                        <div class="text-sm text-gray-400">${timeAgo}</div>
                    </div>
                </div>
                <div class="text-right">
                    <div class="text-sm font-medium">${time}</div>
                    <div class="text-xs text-gray-400">${date}</div>
                </div>
            `;

      if (alert.type === "Human Detection" && alert.imageData) {
        newAlert.addEventListener("click", () => {
          showAlertImage(alert.imageData, alert.message);
        });
      }

      alertsContainer.appendChild(newAlert);
    });
  }

  function showAlertImage(imageData, message) {
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-black/75 flex items-center justify-center z-50";
    modal.innerHTML = `
            <div class="bg-[#131824] p-4 rounded-lg max-w-2xl w-full mx-4">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-medium">${
                      message || "Detection Image"
                    }</h3>
                    <button class="text-gray-400 hover:text-white" onclick="this.closest('.fixed').remove()">
                        <i class="ri-close-line ri-lg"></i>
                    </button>
                </div>
                <img src="${imageData}" class="w-full rounded-lg" alt="Human Detection Image" />
            </div>
        `;
    document.body.appendChild(modal);
  }

  function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";

    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";

    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";

    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";

    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " minutes ago";

    if (seconds < 10) return "just now";
    return Math.floor(seconds) + " seconds ago";
  }

  async function fetchNotificationPreferences() {
    console.log("[fetchNotificationPreferences] Fetching preferences...");
    try {
      const response = await fetch("/api/notification-preferences");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const preferences = await response.json();
      console.log("Fetched notification preferences:", preferences);

      if (emailToggle && typeof preferences.email !== "undefined") {
        emailToggle.checked = preferences.email;
      }
      if (smsToggle && typeof preferences.sms !== "undefined") {
        smsToggle.checked = preferences.sms;
      }
      if (webToggle && typeof preferences.web !== "undefined") {
        webToggle.checked = preferences.web;
        // Update the dynamic text based on the fetched preference
        const browserNotificationStatus = document.getElementById(
          "browserNotificationStatus"
        );
        if (browserNotificationStatus) {
          if (preferences.web) {
            browserNotificationStatus.textContent =
              "Browser notifications are currently enabled.";
            browserNotificationStatus.classList.remove("text-red-500");
            browserNotificationStatus.classList.add("text-green-500");
          } else {
            browserNotificationStatus.textContent =
              "Browser notifications are currently disabled.";
            browserNotificationStatus.classList.remove("text-green-500");
            browserNotificationStatus.classList.add("text-red-500");
          }
        }
      }
    } catch (error) {
      console.error("Error fetching notification preferences:", error);
      showToast("Failed to load notification settings.", "error");
    }
  }

  if (emailToggle) {
    emailToggle.addEventListener("change", async function () {
      console.log(
        "[emailToggle] Change event detected. New state:",
        this.checked
      );
      await updateNotificationSetting(this, "email");
    });
  }

  if (smsToggle) {
    smsToggle.addEventListener("change", async function () {
      console.log(
        "[smsToggle] Change event detected. New state:",
        this.checked
      );
      await updateNotificationSetting(this, "sms");
    });
  }

  if (webToggle) {
    webToggle.addEventListener("change", async function () {
      console.log(
        "[webToggle] Change event detected. New state:",
        this.checked
      );
      await updateNotificationSetting(this, "web");
      // Update the dynamic text immediately on toggle
      const browserNotificationStatus = document.getElementById(
        "browserNotificationStatus"
      );
      if (browserNotificationStatus) {
        if (this.checked) {
          browserNotificationStatus.textContent =
            "Browser notifications are currently enabled.";
          browserNotificationStatus.classList.remove("text-red-500");
          browserNotificationStatus.classList.add("text-green-500");
        } else {
          browserNotificationStatus.textContent =
            "Browser notifications are currently disabled.";
          browserNotificationStatus.classList.remove("text-green-500");
          browserNotificationStatus.classList.add("text-red-500");
        }
      }
    });
  }

  async function updateNotificationSetting(toggleElement, type) {
    console.log(
      `[updateNotificationSetting] Sending update for ${type} to ${toggleElement.checked}`
    );
    try {
      const response = await fetch("/api/update-notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: type,
          enabled: toggleElement.checked,
        }),
      });

      if (response.ok) {
        showToast(
          `${type.charAt(0).toUpperCase() + type.slice(1)} notifications ${
            toggleElement.checked ? "enabled" : "disabled"
          }`,
          "success"
        );
      } else {
        toggleElement.checked = !toggleElement.checked; // Revert UI on failure
        throw new Error(`Failed to update ${type} notifications`);
      }
    } catch (error) {
      console.error(`Error updating ${type} notifications:`, error);
      showToast(`Error updating ${type} notifications`, "error");
    }
  }

  cameraToggle.addEventListener("change", function () {
    isCameraEnabled = this.checked;
    console.log(
      `[cameraToggle] Change event. isCameraEnabled: ${isCameraEnabled}`
    );
    if (isCameraEnabled) {
      initializeCamera(); // This will attempt to get stream and then start monitoring
      // Do not call updateCameraUIStatus(true) here directly,
      // let initializeCamera's success and WebSocket 'camera_status' confirm online status.
      showToast("Attempting to start camera feed...", "info");
    } else {
      stopMonitoring(); // Stop sending frames
      // Explicitly set UI to offline when user turns off the toggle
      updateCameraUIStatus(false);
      cameraFeed.classList.add("hidden");
      noConnectionFeed.classList.remove("hidden");
      showToast("Camera feed stopped by user.", "warning");
      console.log("[cameraToggle] Camera switched OFF. UI set to Offline.");
    }
  });

  const saveButton = document.querySelector("button.bg-primary");
  if (saveButton) {
    saveButton.remove();
  }

  document.querySelectorAll("[data-alert-type]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-alert-type]").forEach((btn) => {
        btn.classList.remove("text-primary", "border-b-2", "border-primary");
        btn.classList.add("text-gray-400");
      });
      button.classList.remove("text-gray-400");
      button.classList.add("text-primary", "border-b-2", "border-primary");

      currentAlertType = button.dataset.alertType;
      updateAlerts();
    });
  });

  const fullscreenButton = document.querySelector(".camera-feed button");
  if (fullscreenButton) {
    fullscreenButton.addEventListener("click", function () {
      const cameraFeedContainer = document.querySelector(".camera-feed");
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        cameraFeedContainer.requestFullscreen().catch((err) => {
          showToast(`Error attempting fullscreen: ${err.message}`, "error");
          console.error("Fullscreen error:", err);
        });
      }
    });
  }

  const timeRangeToggle = document.getElementById("timeRangeToggle");
  const startTimeInput = document.getElementById("startTime");
  const endTimeInput = document.getElementById("endTime");

  if (timeRangeToggle) {
    timeRangeToggle.addEventListener("change", (e) => {
      isTimeRangeActive = e.target.checked;
      console.log(
        `[timeRangeToggle] Change event. isTimeRangeActive: ${isTimeRangeActive}`
      );
      updateTimeRangeStatus(); // This will call start/stop monitoring based on conditions
    });
  }

  if (startTimeInput) {
    startTimeInput.addEventListener("change", (e) => {
      startTime = e.target.value;
      // If time range is active, changing time should disable it for re-evaluation
      if (timeRangeToggle && timeRangeToggle.checked) {
        timeRangeToggle.checked = false;
        isTimeRangeActive = false;
        showToast(
          "Time range changed, toggle reset. Re-enable to activate.",
          "info"
        );
      }
      updateTimeRangeStatus();
      stopMonitoring(); // Always stop monitoring if time range settings change
    });
  }

  if (endTimeInput) {
    endTimeInput.addEventListener("change", (e) => {
      endTime = e.target.value;
      // If time range is active, changing time should disable it for re-evaluation
      if (timeRangeToggle && timeRangeToggle.checked) {
        timeRangeToggle.checked = false;
        isTimeRangeActive = false;
        showToast(
          "Time range changed, toggle reset. Re-enable to activate.",
          "info"
        );
      }
      updateTimeRangeStatus();
      stopMonitoring(); // Always stop monitoring if time range settings change
    });
  }

  // Periodically update time and re-evaluate monitoring status
  setInterval(() => {
    updateCurrentTime();
    updateTimeRangeStatus(); // This will handle starting/stopping monitoring based on time range and camera enabled status
  }, 60000); // Every minute

  function updateCameraFeed(imageData) {
    if (cameraFeed) {
      cameraFeed.src = imageData;
    }
  }

  function updateCurrentTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const dateString = now.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const currentTimeElement = document.getElementById("currentTime");
    if (currentTimeElement) {
      currentTimeElement.textContent = `${timeString} • ${dateString}`;
    }
  }

  // --- Modal Logic ---

  // Function to open the modal
  function openEditModal(field, currentValue) {
    currentEditingField = field;
    if (field === "email") {
      document.querySelector("#editModal h3").textContent =
        "Edit Email Address";
      document.querySelector("#editModal label").textContent = "Email Address";
      contactInput.type = "email";
    } else if (field === "phonenumber") {
      document.querySelector("#editModal h3").textContent = "Edit Phone Number";
      document.querySelector("#editModal label").textContent = "Phone Number";
      contactInput.type = "tel"; // Use type="tel" for phone numbers
    }
    contactInput.value = currentValue === "Not set" ? "" : currentValue; // Clear if 'Not set'
    editModal.style.display = "flex"; // Show the modal
  }

  // Function to close the modal
  function closeEditModal() {
    editModal.style.display = "none"; // Hide the modal
    contactInput.value = ""; // Clear input on close
    currentEditingField = ""; // Reset the editing field
  }

  // Event listeners for edit buttons
  editContactButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.field;
      const currentValue = button.dataset.currentValue;
      openEditModal(field, currentValue);
    });
  });

  // Event listeners for modal close buttons
  if (closeModalButton) {
    closeModalButton.addEventListener("click", closeEditModal);
  }
  if (cancelEditButton) {
    cancelEditButton.addEventListener("click", closeEditModal);
  }
  // Close modal if clicked outside content
  if (editModal) {
    editModal.addEventListener("click", (e) => {
      if (e.target === editModal) {
        closeEditModal();
      }
    });
  }

  // Handle form submission for updating contact info
  if (editForm) {
    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newValue = contactInput.value.trim();

      if (!newValue) {
        showToast(
          `Please enter a valid ${
            currentEditingField === "email" ? "email" : "phone number"
          }.`,
          "error"
        );
        return;
      }

      try {
        const response = await fetch("/api/update-user-contact", {
          // New API endpoint
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            field: currentEditingField, // 'email' or 'phonenumber'
            value: newValue,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            showToast(
              `${
                currentEditingField === "email" ? "Email" : "Phone Number"
              } updated successfully!`,
              "success"
            );
            // Update the displayed value in the UI
            if (currentEditingField === "email" && userEmailDisplay) {
              userEmailDisplay.textContent = newValue;
            } else if (
              currentEditingField === "phonenumber" &&
              userPhoneDisplay
            ) {
              userPhoneDisplay.textContent = newValue;
            }
            // Update the data-current-value attribute on the buttons
            editContactButtons.forEach((button) => {
              if (button.dataset.field === currentEditingField) {
                button.dataset.currentValue = newValue;
              }
            });
            closeEditModal();
          } else {
            throw new Error(
              data.message || `Failed to update ${currentEditingField}.`
            );
          }
        } else {
          const errorData = await response.json();
          throw new Error(
            errorData.message || `Failed to update ${currentEditingField}.`
          );
        }
      } catch (error) {
        console.error("Error updating contact information:", error);
        showToast(`Error: ${error.message}`, "error");
      }
    });
  }

  // --- Initializations on DOMContentLoaded ---
  fetchNotificationPreferences();
  initializeCamera(); // This will attempt to get stream and then start monitoring if conditions met
  loadAlertsFromStorage();
  updateTimeRangeStatus(); // This will also call start/stop monitoring based on initial state
  setInterval(updateCurrentTime, 1000);
  updateCurrentTime();

  // Initial update for browser notification status on load
  const browserNotificationStatus = document.getElementById(
    "browserNotificationStatus"
  );
  if (browserNotificationStatus && webToggle) {
    if (webToggle.checked) {
      browserNotificationStatus.textContent =
        "Browser notifications are currently enabled.";
      browserNotificationStatus.classList.remove("text-red-500");
      browserNotificationStatus.classList.add("text-green-500");
    } else {
      browserNotificationStatus.textContent =
        "Browser notifications are currently disabled.";
      browserNotificationStatus.classList.remove("text-green-500");
      browserNotificationStatus.classList.add("text-red-500");
    }
  }
});
