CLASS zcl_agent_mcp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_row,
        name  TYPE string,
        qty   TYPE i,
        selkz TYPE abap_bool,
      END OF ty_row.
    DATA name     TYPE string.
    DATA express  TYPE abap_bool.
    DATA priority TYPE string.
    DATA result   TYPE string.
    DATA rows     TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
  PRIVATE SECTION.
    METHODS display
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
    METHODS ask
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
ENDCLASS.

CLASS zcl_agent_mcp IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    IF client->check_on_init( ).
      priority = `B`.
      result = `nothing yet`.
      rows = VALUE #( ( name = `alpha` qty = 1 ) ( name = `beta` qty = 2 ) ( name = `gamma` qty = 3 ) ).
      display( client ).
    ELSEIF client->check_on_event( `SAVE` ).
      result = |saved { name } express={ express } priority={ priority }|.
      client->message_toast_display( result ).
    ELSEIF client->check_on_event( `ROW` ).
      result = |row { client->get_event_arg( 1 ) }|.
    ELSEIF client->check_on_event( `DELETE` ).
      DELETE rows WHERE selkz = abap_true.
    ELSEIF client->check_on_event( `ASK` ).
      ask( client ).
    ELSEIF client->check_on_event( `CONFIRM` ).
      client->popup_destroy( ).
      result = `confirmed`.
    ENDIF.
  ENDMETHOD.

  METHOD display.
    DATA(page) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:mvc`  v = `sap.ui.core.mvc`
            )->a( n = `xmlns:core` v = `sap.ui.core`
            )->a( n = `xmlns:form` v = `sap.ui.layout.form`
            )->ele( `Page`
                )->a( n = `title` v = `Agent test app` ).

    DATA(form) = page->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` b = abap_true
        )->ele( n = `content` ns = `form` ).
    form->tag( `Label`
        )->a( n = `text`     v = `Customer`
        )->a( n = `required` b = abap_true
        )->tag( `Input`
            )->a( n = `value` v = client->_bind( name )
        )->tag( `Label`
            )->a( n = `text` v = `Express`
        )->tag( `CheckBox`
            )->a( n = `selected` v = client->_bind( express ) ).
    form->tag( `Label`
        )->a( n = `text` v = `Priority`
        )->ele( `Select`
            )->a( n = `selectedKey` v = client->_bind( priority )
            )->tag( n = `Item` ns = `core`
                )->a( n = `key`  v = `A`
                )->a( n = `text` v = `High`
            )->tag( n = `Item` ns = `core`
                )->a( n = `key`  v = `B`
                )->a( n = `text` v = `Normal` ).
    form->tag( `Label`
        )->a( n = `text` v = `Result`
        )->tag( `Text`
            )->a( n = `text` v = client->_bind( result ) ).

    DATA(table) = page->ele( `Table`
        )->a( n = `headerText` v = `Rows`
        )->a( n = `mode`       v = `MultiSelect`
        )->a( n = `items`      v = client->_bind( rows ) ).
    DATA(columns) = table->ele( `columns` ).
    columns->ele( `Column`
        )->tag( `Text`
            )->a( n = `text` v = `Name` ).
    columns->ele( `Column`
        )->tag( `Text`
            )->a( n = `text` v = `Quantity` ).
    columns->ele( `Column`
        )->tag( `Text`
            )->a( n = `text` v = `Action` ).
    table->ele( `items`
        )->ele( `ColumnListItem`
            )->a( n = `selected` v = `{SELKZ}`
            )->ele( `cells`
                )->tag( `Text`
                    )->a( n = `text` v = `{NAME}`
                )->tag( `Input`
                    )->a( n = `value` v = `{QTY}`
                )->tag( `Button`
                    )->a( n = `text`  v = `Pick`
                    )->a( n = `press` v = client->_event( val   = `ROW`
                                                          t_arg = VALUE #( ( `${NAME}` ) ) ) ).

    page->ele( `footer`
        )->ele( `Toolbar`
            )->tag( `Button`
                )->a( n = `text`  v = `Save`
                )->a( n = `press` v = client->_event( `SAVE` )
            )->tag( `Button`
                )->a( n = `text`  v = `Delete selected`
                )->a( n = `press` v = client->_event( `DELETE` )
            )->tag( `Button`
                )->a( n = `text`  v = `Ask`
                )->a( n = `press` v = client->_event( `ASK` ) ).

    client->view_display( page->stringify( ) ).
  ENDMETHOD.

  METHOD ask.
    DATA(dialog) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `FragmentDefinition` ns = `core`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:core` v = `sap.ui.core`
            )->ele( `Dialog`
                )->a( n = `title` v = `Really?` ).
    dialog->tag( `Text`
        )->a( n = `text` v = `Confirm the order.` ).
    dialog->ele( `buttons`
        )->tag( `Button`
            )->a( n = `text`  v = `Yes`
            )->a( n = `press` v = client->_event( `CONFIRM` )
        )->tag( `Button`
            )->a( n = `text`  v = `Close`
            )->a( n = `press` v = client->_event_client( client->cs_event-popup_close ) ).
    client->popup_display( dialog->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
