// Keep long navigation usable without replacing the shell's existing wheel
// bridge: scroll the rail only while it has content left in that direction.
const navigation = document.querySelector(".v2-desktop-scroll");
navigation?.addEventListener("wheel", event => {
  if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
  const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? navigation.clientHeight : 1;
  const delta = event.deltaY * factor;
  const maximum = Math.max(0, navigation.scrollHeight - navigation.clientHeight);
  if (!maximum || (delta < 0 && navigation.scrollTop <= 0) || (delta > 0 && navigation.scrollTop >= maximum)) return;
  event.preventDefault();
  event.stopPropagation();
  navigation.scrollTop = Math.max(0, Math.min(maximum, navigation.scrollTop + delta));
}, { passive: false });
