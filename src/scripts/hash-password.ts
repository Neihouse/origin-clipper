import { hashPassword } from "../lib/auth/password";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}

console.log(hashPassword(password));
