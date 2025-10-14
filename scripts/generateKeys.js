import { generateKeyPair } from '@stablelib/nacl';
import { encode as encodeBase64 } from '@stablelib/base64';

const senderKeys = generateKeyPair();
const recipientKeys = generateKeyPair();

console.log('Sender Public Key:', encodeBase64(senderKeys.publicKey));
console.log('Sender Private Key:', encodeBase64(senderKeys.secretKey));
console.log('Recipient Public Key:', encodeBase64(recipientKeys.publicKey));
console.log('Recipient Private Key:', encodeBase64(recipientKeys.secretKey));