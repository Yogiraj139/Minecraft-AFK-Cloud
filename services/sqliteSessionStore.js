import session from 'express-session';

export class SQLiteSessionStore extends session.Store {
  constructor({ db }) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(`
      INSERT INTO sessions (sid, sess, expires)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);

      if (!row) {
        callback(null, null);
        return;
      }

      if (row.expires <= Date.now()) {
        this.destroyStmt.run(sid);
        callback(null, null);
        return;
      }

      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiresAt(sess));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      this.touchStmt.run(this.expiresAt(sess), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clearExpired() {
    this.pruneStmt.run(Date.now());
  }

  expiresAt(sess) {
    if (sess?.cookie?.expires) {
      return new Date(sess.cookie.expires).getTime();
    }

    return Date.now() + 1000 * 60 * 60 * 12;
  }
}
