const notificationPermission = { state: 'unknown', granted: false };

function noteNotificationPermission(result) {
  if (!result || typeof result !== 'object') return;
  if (typeof result.state === 'string') notificationPermission.state = result.state;
  if (result.error_code === 'access_denied') notificationPermission.state = 'denied';
  notificationPermission.granted = notificationPermission.state === 'granted' ||
    (result.granted === true && notificationPermission.state !== 'denied');
}

function notificationsBlocked() {
  return notificationPermission.state === 'denied';
}

// False only for a decision already known to be "no". An unreachable
// permissions API is not a denial — let the send itself fail honestly.
async function ensureNotificationPermission(reasonKey) {
  try {
    noteNotificationPermission(await hecaton.permissions.query({ permission: 'notification' }));
    if (notificationPermission.state === 'denied') return false;
    if (notificationPermission.state !== 'prompt') return true;

    noteNotificationPermission(await hecaton.permissions.request({
      permission: 'notification',
      reason: translations(reasonKey),
    }));
    return notificationPermission.granted;
  } catch (e) {
    process.stderr.write('[claude-dashboard] Notification permission check failed: ' + (e.message || e) + '\n');
    return true;
  }
}

async function sendNotification(payload, reasonKey) {
  if (!await ensureNotificationPermission(reasonKey)) {
    process.stderr.write('[claude-dashboard] Notification suppressed: permission not granted\n');
    return { ok: false, error_code: 'access_denied' };
  }
  try {
    const result = await hecaton.notify.send(payload);
    if (result && result.ok === false) {
      noteNotificationPermission(result);
      process.stderr.write('[claude-dashboard] notify.send failed: ' + JSON.stringify(result) + '\n');
      return result;
    }
    return result || { ok: true };
  } catch (e) {
    process.stderr.write('[claude-dashboard] notify.send failed: ' + (e.message || e) + '\n');
    return { ok: false, error: e.message || String(e) };
  }
}

