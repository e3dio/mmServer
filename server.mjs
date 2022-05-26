import { port, maxmind_key, cacheSize } from './config.mjs';
import { App, LIBUS_LISTEN_EXCLUSIVE_PORT } from 'uWebSockets.js';
import LRU from 'lru-cache';
import { Reader } from 'mmdb-lib';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { exec } from 'node:child_process';
import { readFile, readdir, open, access, mkdir } from 'node:fs/promises';

const execPromise = promisify(exec);

await access('./data').catch(e => mkdir('./data'));

const download = async (url, dest) => {
	const fh = await open(dest, 'w');
	await fetch(url).then(r => r.body.pipeTo(Writable.toWeb(fh.createWriteStream())));
	await fh.close();
};

const getLatest = async (type) => {
	const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-${type}&license_key=${maxmind_key}&suffix=tar.gz`;
	const response = await fetch(url, { method: 'HEAD' });
	if (response.status != 200) { console.log('Download error, check API key'); process.exit(1); };
	const tarFile = response.headers.get('content-disposition').slice(21);
	const directory = tarFile.slice(0, -7);
	const db = await readFile(`./data/${directory}/GeoLite2-${type}.mmdb`).catch(async e => {
		console.log(new Date(), `Latest data not found, downloading new ${type} dataset..`);
		await download(url, `./data/${tarFile}`);
		await execPromise(`tar -xf ${tarFile}`, { cwd: './data' });
		return readFile(`./data/${directory}/GeoLite2-${type}.mmdb`);
	});
	const cache = new LRU({ max: cacheSize });
	return new Reader(db, { cache });
};

let City, ASN;
const load = async () => [ City, ASN ] = await Promise.all(getLatest('City'), getLatest('ASN'));

await load();
setInterval(() => new Date().getDay() == 3 && load(), 1000 * 60 * 60 * 24); // new dataset available every Tuesday

App().ws('/', {
	message: (ws, m, b) => {
		const ip = Buffer.from(m).toString();
		const c = City.get(ip);
		const city = c?.city?.names?.en || '';
		const state = c?.subdivisions?.[0]?.names?.en || '';
		const stateISO = c?.subdivisions?.[0]?.iso_code || '';
		const country = c?.country?.names?.en || '';
		const countryISO = c?.country?.iso_code || '';
		const lat = c?.location?.latitude || '';
		const lon = c?.location?.longitude || '';
		const asn = ASN.get(ip)?.autonomous_system_organization || '';
		ws.send(JSON.stringify({ ip, city, state, stateISO, country, countryISO, lat, lon, asn }));
	}
}).listen(port, LIBUS_LISTEN_EXCLUSIVE_PORT, listenSocket => {
	if (listenSocket) { console.log(`Listening on ${port}`); }
	else { console.log(`Listen on ${port} failed`); process.exit(1); }
});
