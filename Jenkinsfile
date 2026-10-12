// One shop in, one LinkedIn note out. The hourly Alexa feed stays on GitHub Actions.
// Point a Jenkins Pipeline job at this file. The agent needs Node.js 20 or newer.
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    choice(
      name: 'SHOP',
      choices: [
        'Mahir Ahmed',
        'FlickFinder',
        'Sakinah',
        'Motiv',
        "KARV'D",
        'Kiano London',
        'Sweet Dezire',
        'Blanco Coffee House',
        'RAPIDER',
        'D Apartment Sylhet',
        'Abayas Boutique',
        "Tara's Bakes",
      ].join('\n'),
      description: 'Shop to check. The address comes from the site list.'
    )
  }

  stages {
    stage('Write the LinkedIn note') {
      steps {
        script {
          def shop = params.SHOP?.trim()
          if (!shop) {
            error 'Pick a shop from the list, then run the job again.'
          }
          def url = shopUrl(readFile('site-status/sites.json'), shop)
          if (!url) {
            error "No address is listed for ${shop}."
          }
          writeFile file: 'site-status/pitch-request.json', text: groovy.json.JsonOutput.toJson([name: shop, url: url])
        }
        dir('site-status') {
          sh 'node --version'
          sh 'node scripts/pitch.mjs pitch-request.json pitch.txt'
        }
      }
    }
  }

  post {
    success {
      archiveArtifacts artifacts: 'site-status/pitch.txt', onlyIfSuccessful: true
    }
    cleanup {
      sh 'rm -f site-status/pitch-request.json site-status/pitch.txt'
    }
  }
}

@NonCPS
String shopUrl(String raw, String shop) {
  def parsed = new groovy.json.JsonSlurperClassic().parseText(raw)
  return parsed.sites.find { it.name == shop }?.url
}
