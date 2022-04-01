import { port, maxmind_key, cacheSize } from './config.mjs';
import { App, LIBUS_LISTEN_EXCLUSIVE_PORT } from 'uWebSockets.js';
import { Reader } from 'mmdb-lib';
import LRU from 'lru-cache';
import { readFile, readdir, open, access, mkdir } from 'fs/promises';
import { Writable } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

const moreThanWeekOld = (date) => date < new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);

await access('./data').catch(e => mkdir('./data'));

const download = async (url, dest) => {
	const fh = await open(dest, 'w');
	await fetch(url).then(r => r.body.pipeTo(Writable.toWeb(fh.createWriteStream())));
	await fh.close();
};

const getLatest = async (type) => {
	const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-${type}&license_key=${maxmind_key}&suffix=tar.gz`;
	let file = await readdir('./data').then(files => files.sort().reverse().find(a => a.startsWith(`GeoLite2-${type}`) && !a.endsWith('.tar.gz')));
	if (!file || moreThanWeekOld(new Date(`${file.slice(-8, -4)}-${file.slice(-4, -2)}-${file.slice(-2)}`))) {
		console.log(new Date(), `Downloading new ${type} dataset..`);
		const response = await fetch(url, { method: 'HEAD' });
		if (response.status != 200) { console.log('Download error, check API key'); process.exit(1); };
		const filename = response.headers.get('content-disposition').slice(21);
		file = filename.slice(0, -7);
		await download(url, `./data/${filename}`).then(() => execPromise(`tar -xf ${filename}`, { cwd: './data' }));
	}
	const cache = new LRU({ max: cacheSize });
	const db = await readFile(`./data/${file}/GeoLite2-${type}.mmdb`);
	return new Reader(db, { cache });
};

let City, ASN;
const load = async () => [ City, ASN ] = await Promise.all([ 'City', 'ASN' ].map(getLatest));
await load();
setInterval(load, 1000 * 60 * 60 * 24 * 7); // data updated every 7 days

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
}).listen(port, LIBUS_LISTEN_EXCLUSIVE_PORT, s => {
	console.log(s ? `listening on ${port}` : 'listen failed');
});
