/**
 * TMC Contract Dashboard – Google Calendar sync.
 *
 * Runs under your Google account and puts contract / compliance dates into your
 * Google Calendar, inviting each item's owner by email. The dashboard sends the
 * dates; this script only creates, updates or removes the events it made.
 *
 * Setup: paste this whole file into a new project at https://script.google.com,
 * run the "authorize" function once and allow Calendar access,
 * then Deploy → New deployment → Web app, "Execute as: Me", "Who has access: Anyone".
 * Copy the web app URL into the dashboard (Settings → Google Calendar).
 */

const SECRET = '__SECRET__'; // the dashboard fills this in; keep it private

// Run this once from the editor (▷ Run) so Google asks you to allow Calendar access.
function authorize() {
  const cal = CalendarApp.getDefaultCalendar();
  Logger.log('Calendar access OK: ' + cal.getName());
}

function doGet() {
  return out({ ok: true, service: 'TMC calendar sync' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'Bad request' });
  }
  if (!req || req.key !== SECRET) return out({ ok: false, error: 'Wrong key: copy the script again from the dashboard and redeploy.' });
  try {
    const cal = CalendarApp.getDefaultCalendar();
    if (req.action === 'ping') return out({ ok: true, calendar: cal.getName(), account: Session.getEffectiveUser().getEmail() });
    if (req.action === 'sync') return out({ ok: true, events: sync(cal, req.events || [], req.existing || {}) });
    if (req.action === 'remove') {
      Object.keys(req.existing || {}).forEach((k) => removeEvent(cal, req.existing[k]));
      return out({ ok: true });
    }
    return out({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

// events: [{ key, date: 'YYYY-MM-DD', title, description, guests: [], reminderDays: [] }]
// existing: { key: eventId } for events this script made earlier for the same item
function sync(cal, events, existing) {
  const ids = {};
  const wanted = {};
  events.forEach((ev) => { wanted[ev.key] = true; });

  events.forEach((ev) => {
    const date = toDate(ev.date);
    const guests = (ev.guests || []).map((g) => g.trim().toLowerCase()).filter(Boolean);
    let event = existing[ev.key] ? findEvent(cal, existing[ev.key]) : null;
    if (event) {
      event.setTitle(ev.title);
      event.setAllDayDate(date);
      event.setDescription(ev.description || '');
      const current = event.getGuestList().map((g) => g.getEmail().toLowerCase());
      guests.filter((g) => current.indexOf(g) < 0).forEach((g) => event.addGuest(g));
      current.filter((g) => guests.indexOf(g) < 0).forEach((g) => event.removeGuest(g));
    } else {
      event = cal.createAllDayEvent(ev.title, date, { description: ev.description || '', guests: guests.join(','), sendInvites: true });
    }
    // reminders for you (the organiser): email + pop-up at 9:00 the given days before
    event.removeAllReminders();
    (ev.reminderDays || []).slice(0, 2).forEach((days) => {
      const minutes = Math.min(40320, Math.max(0, days * 1440 - 9 * 60));
      event.addEmailReminder(minutes);
      event.addPopupReminder(minutes);
    });
    ids[ev.key] = event.getId();
  });

  // events for dates that no longer exist (milestone removed, notice period cleared, …)
  Object.keys(existing).forEach((k) => { if (!wanted[k]) removeEvent(cal, existing[k]); });
  return ids;
}

function findEvent(cal, id) {
  try {
    return cal.getEventById(id);
  } catch (err) {
    return null;
  }
}

function removeEvent(cal, id) {
  const ev = findEvent(cal, id);
  if (ev) ev.deleteEvent();
}

function toDate(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
