process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://913841dc7a6a44a59bb26b70df222286:34e4ff6001884d0fac9091d4c1fee102@sentry.cozycloud.cc/25'

const moment = require('moment')
moment.locale('fr')

const { log, CookieKonnector, errors, retry } = require('cozy-konnector-libs')

class OrangeConnector extends CookieKonnector {
  async testSession() {
    try {
      if (!this._jar._jar.toJSON().cookies.length) {
        return false
      }
      log('info', 'Testing session')
      const $ = await this.getHistory()
      const result = $('#login').length === 0
      if (result) log('info', 'Session is OK')
      return result
    } catch (err) {
      log('warn', err.message)
      log('warn', 'Session failed')
      return false
    }
  }

  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.logIn(fields)
    }
    let $ = await this.fetchPage()
    const entries = this.parsePage($)
    return this.saveBills(entries, fields.folderPath, {
      timeout: Date.now() + 60 * 1000,
      identifiers: ['orange'],
      dateDelta: 12,
      amountDelta: 5
    })
  }

  async logIn(fields) {
    try {
      this.request = this.requestFactory({
        json: true,
        cheerio: false
      })
      const resolveWithFullResponse = true

      // Get cookies from login page.
      log('info', 'Get login form')
      let response = await this.request({
        uri: 'https://login.orange.fr/',
        resolveWithFullResponse
      })

      const headers = {
        'x-auth-id': response.headers['x-auth-id'],
        'x-xsrf-token': response.headers['x-xsrf-token']
      }
      const { login, password } = fields

      log('info', 'Send login with first XSRF token...')

      response = await this.request({
        method: 'POST',
        url: 'https://login.orange.fr/front/login',
        headers,
        body: {
          login
        },
        resolveWithFullResponse
      })

      headers['x-xsrf-token'] = response.headers['x-xsrf-token']
      log('info', 'Send password with second XSRF token...')

      const body = await this.request({
        method: 'POST',
        url: 'https://login.orange.fr/front/password',
        headers,
        body: {
          login,
          password
        }
      })

      if (body.credential != null || body.password != null) {
        throw new Error(body.credential || body.password)
      }
    } catch (err) {
      log('error', err)
      if (err && err.message.includes('bloqué')) {
        throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
      } else if (err && err.message.includes('un problème technique')) {
        throw new Error(errors.VENDOR_DOWN)
      } else if (err.statusCode === 401) {
        throw new Error(errors.LOGIN_FAILED)
      } else {
        throw new Error(errors.VENDOR_DOWN)
      }
    }
    log('info', 'Successfully logged in.')
  }

  async fetchPage() {
    let $
    try {
      $ = await retry(this.getHistory, {
        context: this,
        interval: 10000,
        throw_original: true,
        // retry only if we get a timeout error
        predicate: err => {
          const isTimeout = err.cause && err.cause.code === 'ETIMEDOUT'
          if (isTimeout)
            log('info', 'We go the famous timeout error. Trying multiple times')
          return isTimeout
        }
      })
    } catch (err) {
      const isTimeout = err.cause && err.cause.code === 'ETIMEDOUT'
      if (isTimeout) {
        throw new Error(errors.VENDOR_DOWN)
      } else {
        throw err
      }
    }
    // if multiple contracts choices, choose the first one
    const contractChoices = $('.ec-contractPanel-description a')
      .map(function(index, elem) {
        const $elem = $(elem)
        return {
          link: $elem.attr('href'),
          text: $elem.text()
        }
      })
      .get()
      .filter(
        value => value.text.includes('Livebox') || value.text.includes('Orange')
      )
    if (contractChoices.length) {
      // take the first orange contract at the moment
      return this.request(
        `https://espaceclientv3.orange.fr/${contractChoices[0].link}`
      )
    } else return $
  }

  parsePage($) {
    const entries = []

    // Anaylyze bill listing table.
    log('info', 'Parsing bill pages')
    $('table tbody tr').each(function() {
      let date = $(this)
        .find('td[headers=ec-dateCol]')
        .text()
      date = moment(date, 'LL')
      let amount = $(this)
        .find('td[headers=ec-amountCol]')
        .text()
      amount = parseFloat(
        amount
          .trim()
          .replace(' €', '')
          .replace(',', '.')
      )
      let fileurl = $(this)
        .find('td[headers=ec-downloadCol] a')
        .attr('href')

      // Add a new bill information object.
      let bill = {
        date: date.toDate(),
        amount,
        fileurl,
        filename: getFileName(date),
        type: 'phone',
        vendor: 'Orange'
      }

      if (bill.date != null && bill.amount != null) {
        entries.push(bill)
      }
    })

    log('info', `Bill retrieved: ${entries.length} found`)
    return entries
  }

  getHistory() {
    this.request = this.requestFactory({
      json: false,
      cheerio: true
    })
    return this.request({
      url: 'https://espaceclientv3.orange.fr/?page=factures-historique',
      timeout: 5000
    })
  }
}

const connector = new OrangeConnector({
  // debug: true
})

connector.run()

function getFileName(date) {
  return `${date.format('YYYYMM')}_orange.pdf`
}
