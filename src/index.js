const {
  BaseKonnector,
  requestFactory,
  log,
  scrape,
  saveBills,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const format = require('date-fns/format')
const pdfjs = require('pdfjs-dist')
const stream = require('stream')
const bluebird = require('bluebird')

const baseUrl = 'https://client.o2.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  await handleBills(fields)
}

async function handleBills(fields) {
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
    filename: `${format(bill.date, 'YYYY-MM')}_o2.pdf`,
    vendor: 'O2',
    currency: '€',
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))

  // now parse data in pdf files and save associated bill for each bill, to avoid save all the pdf
  // files in memory
  bills = await bluebird.mapSeries(bills, async bill => {
    log('info', `parsing pdf file for ${bill.date} bill`)
    const result = await findAndAddAmount(bill)
    log('info', `got amount ${bill.amount}`)
    log('info', `Now saving this bill to Cozy`)
    await saveBills([result], fields.folderPath, {
      identifiers: ['o2'],
      contentType: 'application/pdf'
    })
    return result
  })
}

// Parse the pdf file to get the amount of the bill
// To avoid to fetch the file twice, we also add it as filestream in the bill map
async function findAndAddAmount(bill) {
  const result = { ...bill }
  const rq = requestFactory({
    cheerio: false,
    json: false,
    jar: true
  })
  const pdfBuffer = await rq({
    url: result.fileurl,
    encoding: null
  })

  const doc = await pdfjs.getDocument(new Uint8Array(pdfBuffer))
  const page = await doc.getPage(1)
  const textContent = await page.getTextContent()

  // find the height of the cell with 'SOLDE NET' as text
  const topSoldeNetPreleve = textContent.items.find(
    item => item.str.indexOf('SOLDE NET') !== -1
  ).transform[5]

  // find another cell with the same height : it is the amount
  const amount = textContent.items.find(
    item => item.transform[5] === topSoldeNetPreleve
  ).str

  result.amount = parseFloat(amount.replace(',', '.').replace(' €', ''))

  // add the pdf stream to the bill
  const bufferStream = new stream.PassThrough()
  bufferStream.end(pdfBuffer)
  result.filestream = bufferStream
  delete result.fileurl
  return result
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
