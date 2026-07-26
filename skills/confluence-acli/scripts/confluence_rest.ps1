[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$BodyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RequiredEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required environment variable '$Name' is not set."
    }

    return $value.Trim()
}

$siteInput = Get-RequiredEnvironmentValue -Name 'CONFLUENCE_SITE'
$email = Get-RequiredEnvironmentValue -Name 'CONFLUENCE_EMAIL'
$token = Get-RequiredEnvironmentValue -Name 'CONFLUENCE_API_TOKEN'

if ($siteInput -match '^https?://') {
    $siteUri = [Uri]$siteInput
    if ($siteUri.Scheme -ne 'https' -or $siteUri.AbsolutePath -ne '/') {
        throw 'CONFLUENCE_SITE must be an HTTPS Atlassian Cloud site root without a path.'
    }
    $site = $siteUri.Host
}
else {
    $site = $siteInput.TrimEnd('/')
}

if ($site -notmatch '^[A-Za-z0-9.-]+\.atlassian\.net$') {
    throw 'CONFLUENCE_SITE must be an Atlassian Cloud hostname ending in .atlassian.net.'
}

if ($Path -notmatch '^/wiki/(api/v2|rest/api)(/|\?|$)') {
    throw "Path must begin with '/wiki/api/v2/' or '/wiki/rest/api/'."
}

if ($Path -match '\.\.' -or $Path -match '[\r\n]') {
    throw 'Path contains a disallowed sequence.'
}

$requestBody = $null
if ($BodyFile) {
    if ($Method -notin @('POST', 'PUT')) {
        throw 'BodyFile is supported only for POST and PUT requests.'
    }

    $resolvedBodyFile = (Resolve-Path -LiteralPath $BodyFile).Path
    $requestBody = [IO.File]::ReadAllText(
        $resolvedBodyFile,
        [Text.UTF8Encoding]::new($false)
    )

    try {
        $null = $requestBody | ConvertFrom-Json
    }
    catch {
        throw "BodyFile is not valid JSON: $($_.Exception.Message)"
    }
}
elseif ($Method -in @('POST', 'PUT')) {
    throw 'POST and PUT requests require BodyFile.'
}

$credentialBytes = [Text.Encoding]::UTF8.GetBytes("${email}:${token}")
$authorization = 'Basic ' + [Convert]::ToBase64String($credentialBytes)
$headers = @{
    Accept = 'application/json'
    Authorization = $authorization
}

$request = @{
    Uri = "https://${site}${Path}"
    Method = $Method
    Headers = $headers
    UseBasicParsing = $true
}

if ($null -ne $requestBody) {
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Body = [Text.Encoding]::UTF8.GetBytes($requestBody)
}

try {
    $response = Invoke-WebRequest @request
}
catch {
    $exceptionMessage = $_.Exception.Message
    $exceptionResponse = $_.Exception.Response
    $statusCode = $null
    $retryAfter = $null
    $rateLimitReason = $null

    if ($null -ne $exceptionResponse) {
        try {
            $statusCode = [int]$exceptionResponse.StatusCode
        }
        catch {
            $statusCode = $null
        }

        try {
            $retryAfter = $exceptionResponse.Headers['Retry-After']
            $rateLimitReason = $exceptionResponse.Headers['RateLimit-Reason']
        }
        catch {
            $retryAfter = $null
            $rateLimitReason = $null
        }
    }

    $details = @()
    if ($null -ne $statusCode) {
        $details += "HTTP $statusCode"
    }
    if (-not [string]::IsNullOrWhiteSpace($retryAfter)) {
        $details += "Retry-After=$retryAfter"
    }
    if (-not [string]::IsNullOrWhiteSpace($rateLimitReason)) {
        $details += "RateLimit-Reason=$rateLimitReason"
    }

    $detailText = if ($details.Count -gt 0) {
        ' (' + ($details -join ', ') + ')'
    }
    else {
        ''
    }

    throw "Confluence request failed${detailText}: $exceptionMessage"
}
finally {
    $token = $null
    $authorization = $null
    $credentialBytes = $null
    $headers.Authorization = $null
}

if ([string]::IsNullOrWhiteSpace($response.Content)) {
    [ordered]@{
        statusCode = [int]$response.StatusCode
        status = $response.StatusDescription
    } | ConvertTo-Json -Compress
}
else {
    $response.Content
}
