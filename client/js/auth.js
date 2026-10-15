// Authentication and Session Manager

const Auth = {
  TOKEN_KEY: "nexus_token",
  USER_KEY: "nexus_user",

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  getUser() {
    const raw = localStorage.getItem(this.USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  setSession(token, user) {
    if (token) localStorage.setItem(this.TOKEN_KEY, token);
    if (user) localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  },

  logout() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    window.location.href = "/";
  },

  // Fallback guest profile if user enters room directly without account
  getOrCreateGuest() {
    let user = this.getUser();
    if (user) return user;

    let guestId = localStorage.getItem("nexus_guest_id");
    if (!guestId) {
      guestId = "guest_" + Math.random().toString(36).substring(2, 9);
      localStorage.setItem("nexus_guest_id", guestId);
    }

    const colors = ["#6366F1", "#EC4899", "#8B5CF6", "#10B981", "#F59E0B", "#06B6D4", "#3B82F6"];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];

    user = {
      id: guestId,
      username: guestId,
      display_name: "Guest " + guestId.substring(6, 10).toUpperCase(),
      avatar_color: randomColor,
      is_guest: true
    };
    return user;
  },

  async login(username, password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Login failed");
    this.setSession(data.access_token, data.user);
    return data.user;
  },

  async register(username, email, password, displayName, avatarColor) {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email,
        password,
        display_name: displayName,
        avatar_color: avatarColor || "#6366F1"
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Registration failed");
    this.setSession(data.access_token, data.user);
    return data.user;
  }
};
