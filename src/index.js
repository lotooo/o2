const {
  BaseKonnector,
  requestFactory,
  log,
  scrape,
  saveFiles,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const format = require('date-fns/format')

const baseUrl = 'https://client.o2.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching bills information')
  const bills = await fetchAndParseBills()
  log('info', 'Fetched bills information')

  log('info', 'Downloading bills')
  await saveFiles(bills, fields.folderPath)
}

async function fetchAndParseBills() {
  let $ = await request(`${baseUrl}/factures/`)

  const agencyId = $('#agence_id')
    .text()
    .trim()

  const years = Array.from($('.year_invoice option')).map(option =>
    $(option).val()
  )

  let bills = []
  for (const year of years) {
    const $ = await request({
      url: `${baseUrl}/wp-admin/admin-ajax.php`,
      method: 'POST',
      form: {
        action: 'invoiceByYear',
        agenceId: agencyId,
        year
      }
    })
    bills = bills.concat(
      scrape(
        $,
        {
          fileurl: {
            sel: 'a',
            attr: 'href',
            parse: href => `${baseUrl}${href}`
          },
          date: {
            sel: 'a',
            attr: 'href',
            parse: text => {
              const json = JSON.parse(
                text.match(/\{.*\}/)[0].replace(/'/g, '"')
              )
              return new Date(json.endDate)
            }
          }
        },
        'li'
      )
    )
  }

  // add filenames
  bills = bills.map(bill => ({
    ...bill,
    filename: `${format(bill.date, 'YYYY-MM')}_o2.pdf`
  }))

  return bills
}

async function authenticate(username, password) {
  const request = requestFactory({ cheerio: false })
  const result = await request({
    url: `${baseUrl}/wp-admin/admin-ajax.php`,
    method: 'POST',
    form: {
      action: 'ask_login',
      login: username,
      pwd: password
    }
  })

  let json
  try {
    json = JSON.parse(result.trim())
  } catch (err) {
    log('error', 'Could not parse JSON response')
    log('error', err.message)
    throw new Error(errors.VENDOR_DOWN)
  }

  if (!json || json.state !== 'success') {
    throw new Error(errors.LOGIN_FAILED)
  }
}
