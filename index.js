#!/usr/bin/env node
const fs = require('fs').promises
const path = require('path')

const _ = require('lodash')
const mu = require('mustache')
const debug = require('debug')('fb:generate')

const vars = require('./templates/vars.json')
/*
	Consider using https://github.com/koblas/sops-decoder-node
	for now it needs `sops -d templates/secrets.json > templates/clear_secrets.json`
*/
let secrets = {}
try {
	secrets = require('./templates/clear_secrets.json')
} catch (error) {
	if (error.code !== 'MODULE_NOT_FOUND') {
		throw error
	}

	debug('no secrets file available, moving on...')
}

const dataView = _.merge(vars, secrets)
debug('dataView is:\n%O', dataView)

const tplExt = '.mustache'
const tplDir = 'templates'
const parDir = path.join(tplDir, 'partials')
const distDir = 'dist'

/**
 * Creates a directory or no-op
 * TODO: make it possible to recurse and ensure arbitrary directories
 * @param {String} dir path to create or ensure
 * @param {Object|Number} opts options object or mode number
 * @returns {Promise} resolved with no arguments or rejected with error
 */
async function ensureDir (dir, opts) {
	if (!opts || typeof opts === 'number') {
		opts = {
			recursive: false,
			mode: opts
		}
	}

	const { mode } = opts

	if (mode === undefined) {
		opts.mode = 0o777 & (~process.umask())
	}

	const p = path.resolve(dir)
	try {
		await fs.mkdir(p, opts)
		debug(
			'directory %s created with %o',
			path.relative(process.cwd(), p),
			opts
		)
	} catch (error) {
		if (error.code !== 'EEXIST') {
			throw error
		}

		debug(
			'directory %s already exists, moving on...',
			path.relative(process.cwd(), p)
		)
	}

	fs.mkdir(p, mode, er => {
		if (!er) {
			made = made || p
			return callback(null, made)
		}

		switch (er.code) {
		case 'ENOENT':
			if (path.dirname(p) === p) return er
			mkdirs(path.dirname(p), opts, (er, made) => {
				if (er) return er
				else mkdirs(p, opts, callback, made)
			})
			break

		// In the case of any other error, just see if there's a dir
		// there already.  If so, then hooray!  If not, then something
		// is borked.
		default:
			xfs.stat(p, (er2, stat) => {
				// if the stat fails, then that's super weird.
				// let the original error be the failure reason.
				if (er2 || !stat.isDirectory()) callback(er, made)
				else callback(null, made)
			})
			break
		}
	})
}

/**
 * Reads directory and filters results for specific pattern
 * @param {String} scanDir path to scan
 * @param {RegExp} ext file extension
 * @return {Promise} containing a Dirent array
 */
async function getFiles (scanDir, ext) {
	const files = await fs.readdir(scanDir, { withFileTypes: true })
	const filteredFiles = files.filter(dirent =>
		dirent.isFile() &&
		(path.extname(dirent.name) === ext)
	)
	const fileContents = Promise.all(
		filteredFiles.map(async dirent => {
			const fBase = dirent.name
			const fName = path.parse(fBase).name
			const absPath = path.resolve(scanDir, fBase)
			debug(
				'loading %s from %s',
				path.relative(scanDir, absPath),
				scanDir
			)
			return {
				name: fName,
				contents: await fs.readFile(absPath, 'utf8')
			}
		})
	)
	return fileContents
}

/**
 * Renders the template asyncronously
 * @param {String} tpl template string
 * @param {Object} data JSON data for template
 * @param {Object} parts partials
 * @return {Promise} containing rendered string
 */
async function render (tpl, data, parts) {
	return new Promise((resolve, reject) => {
		try {
			const rendered = mu.render(tpl, data, parts)
			resolve(rendered)
		} catch (error) {
			reject(error)
		}
	})
}

/**
 * Main function
 * @return {VoidFunction} no data returned
 */
async function main () {
	try {
		const templates = getFiles(tplDir, tplExt)
		const partials = getFiles(parDir, tplExt)
		const loaded = _.zipObject(
			['templates', 'partials'],
			await Promise.all([templates, partials])
		)
		const partObj = loaded.partials.reduce(
			(acc, cur/* , idx, src */) => ({
				...acc,
				[cur.name]: cur.contents
			}),
			{}
		)
		const rendered = await Promise.all(
			loaded.templates.map(async tpl => {
				return _.assign(tpl, {
					contents: await render(tpl.contents, dataView, partObj)
				})
			})
		)
		await ensureDir(distDir, { mode: 0o775 })
		await Promise.all(
			rendered.map(async tpl => {
				const outFile = path.resolve(distDir, tpl.name)
				await fs.writeFile(outFile, tpl.contents, { mode: 0o664 })
				debug('written out %s', path.relative(process.cwd(), outFile))
			})
		)
	} catch (error) {
		debug(error)
	}
}

main().catch(error => {
	debug(error)
	setTimeout(() => {
		process.exit(-1)
	}, 100)
})
