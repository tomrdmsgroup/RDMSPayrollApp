function createTransport() {
  return {
    async sendMail(mail) {
      console.warn('nodemailer fallback used; email not actually sent');
      return { messageId: `fallback-${Date.now()}`, mail };
    },
  };
}

module.exports = { createTransport };
